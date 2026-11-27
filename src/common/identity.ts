/** Normalises a Nigerian phone number to E.164 (+234XXXXXXXXXX). Returns null if it isn't one. */
export function normalisePhone(input: string): string | null {
  const digits = input.replace(/[^\d+]/g, '');
  let d = digits.startsWith('+') ? digits.slice(1) : digits;
  if (/^0\d{10}$/.test(d)) d = '234' + d.slice(1);
  if (/^234\d{10}$/.test(d)) return '+' + d;
  return null;
}

export function normaliseEmail(input: string): string {
  return input.trim().toLowerCase();
}

/**
 * A plain shape check for an e-mail address (something@domain.tld), done without a backtracking regular expression
 * so a long crafted value in an uploaded spreadsheet cannot tie up the server.
 */
export function looksLikeEmail(email: string): boolean {
  if (email.length > 254 || /\s/.test(email)) return false;
  const at = email.indexOf('@');
  if (at < 1 || at !== email.lastIndexOf('@')) return false;
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  return dot > 0 && dot < domain.length - 1;
}

/** Works out whether a login identifier is an email or a phone number. */
export function parseIdentifier(input: string): { email?: string; phone?: string } | null {
  const v = input.trim();
  if (v.includes('@')) return { email: normaliseEmail(v) };
  const phone = normalisePhone(v);
  return phone ? { phone } : null;
}
