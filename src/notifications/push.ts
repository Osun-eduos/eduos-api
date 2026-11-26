import { createSign } from 'crypto';

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, string>;
}
export interface PushResult {
  ok: boolean;
  /** The phone has uninstalled the app or the token expired: forget it. */
  gone?: boolean;
  error?: string;
}
export interface PushProvider {
  readonly name: string;
  send(token: string, m: PushMessage): Promise<PushResult>;
}

/** Firebase service account fields we use. */
interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

/** Reads FIREBASE_SERVICE_ACCOUNT as JSON or base64-encoded JSON. Returns null when it is missing or unusable. */
export function readServiceAccount(raw: string | undefined): ServiceAccount | null {
  if (!raw?.trim()) return null;
  try {
    const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const j = JSON.parse(text) as ServiceAccount;
    return j.project_id && j.client_email && j.private_key ? j : null;
  } catch {
    return null;
  }
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/**
 * Firebase Cloud Messaging (HTTP v1). Signs a short-lived Google access token from the service account itself,
 * so no Google client library is needed.
 */
export class FcmProvider implements PushProvider {
  readonly name = 'fcm';
  private token: { value: string; expires: number } | null = null;
  constructor(private readonly account: ServiceAccount, private readonly http: typeof fetch = fetch) {}

  private async accessToken() {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({ iss: this.account.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
    const signature = b64url(createSign('RSA-SHA256').update(`${head}.${claims}`).sign(this.account.private_key));
    const res = await this.http('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${signature}` }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !j.access_token) throw new Error(`Google sign-in for push failed: ${j.error_description ?? res.status}`);
    this.token = { value: j.access_token, expires: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  async send(token: string, m: PushMessage): Promise<PushResult> {
    try {
      const res = await this.http(`https://fcm.googleapis.com/v1/projects/${this.account.project_id}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: m.title, body: m.body },
            data: m.data ?? {},
            android: { priority: 'high', notification: { channel_id: 'eduos_parents' } },
            apns: { payload: { aps: { sound: 'default' } } },
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return { ok: true };
      const j = (await res.json().catch(() => ({}))) as { error?: { status?: string; message?: string; details?: { errorCode?: string }[] } };
      const code = j.error?.details?.find((d) => d.errorCode)?.errorCode ?? j.error?.status;
      return { ok: false, gone: res.status === 404 || code === 'UNREGISTERED' || code === 'INVALID_ARGUMENT', error: `${res.status} ${code ?? ''} ${j.error?.message ?? ''}`.trim() };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}

/** Tests: records what would be pushed. */
export class MemoryPush implements PushProvider {
  readonly name = 'memory';
  readonly sent: { token: string; m: PushMessage }[] = [];
  async send(token: string, m: PushMessage): Promise<PushResult> {
    this.sent.push({ token, m });
    return { ok: true };
  }
}
