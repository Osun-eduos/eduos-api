/** Sends one text message. Implementations must not throw for provider refusals; they return `ok: false` instead. */
export interface SmsProvider {
  readonly name: string;
  send(to: string, body: string): Promise<SmsResult>;
  balance?(): Promise<string | null>;
}

export interface SmsResult {
  ok: boolean;
  /** Worth trying again later (network trouble, provider busy), as opposed to a refusal such as a bad number. */
  retry?: boolean;
  providerId?: string;
  cost?: string;
  error?: string;
}

/** Development and tests: records messages instead of sending them. */
export class LogProvider implements SmsProvider {
  readonly name = 'log';
  readonly sent: { to: string; body: string }[] = [];
  async send(to: string, body: string): Promise<SmsResult> {
    this.sent.push({ to, body });
    return { ok: true, providerId: `log-${this.sent.length}` };
  }
  async balance() {
    return null;
  }
}

/** KudiSMS error codes that will not succeed on a retry. */
const KUDI_FINAL = new Set(['100', '101', '103', '104', '105', '106', '107', '111', '114', '185', '188', '300']);

/**
 * KudiSMS (https://kudisms.net). The corporate route is for transactional alerts and reaches numbers on DND;
 * it needs an approved corporate sender ID. The bulk route needs a promotional sender ID and skips DND numbers.
 */
export class KudiSmsProvider implements SmsProvider {
  readonly name = 'kudisms';
  constructor(
    private readonly opts: { token: string; senderId: string; route: 'corporate' | 'sms'; baseUrl?: string },
    private readonly http: typeof fetch = fetch,
  ) {}

  private async post(path: string, body: Record<string, unknown>) {
    const res = await this.http(`${this.opts.baseUrl ?? 'https://my.kudisms.net/api'}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ token: this.opts.token, ...body }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, json, text };
  }

  async send(to: string, body: string): Promise<SmsResult> {
    const recipients = to.replace(/^\+/, '');
    try {
      const { status, json, text } = await this.post(this.opts.route, {
        senderID: this.opts.senderId,
        recipients,
        message: body,
        ...(this.opts.route === 'sms' ? { gateway: '2' } : {}),
      });
      const code = String(json.error_code ?? '');
      if (json.status === 'success' && code === '000') {
        const data = Array.isArray(json.data) ? json.data[0] : json.data;
        const providerId = typeof data === 'string' ? data.split('|')[1] : undefined;
        return { ok: true, providerId, cost: json.cost != null ? String(json.cost) : undefined };
      }
      const error = `KudiSMS ${code || status}: ${String(json.msg ?? text).slice(0, 200)}`;
      return { ok: false, error, retry: !KUDI_FINAL.has(code) };
    } catch (e) {
      return { ok: false, retry: true, error: `KudiSMS could not be reached: ${(e as Error).message}` };
    }
  }

  async balance() {
    try {
      const { json } = await this.post('balance', {});
      const b = json.balance ?? (json.data as Record<string, unknown> | undefined)?.balance;
      return b != null ? String(b) : null;
    } catch {
      return null;
    }
  }
}
