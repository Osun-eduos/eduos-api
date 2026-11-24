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

/** Works out whether a login identifier is an email or a phone number. */
export function parseIdentifier(input: string): { email?: string; phone?: string } | null {
  const v = input.trim();
  if (v.includes('@')) return { email: normaliseEmail(v) };
  const phone = normalisePhone(v);
  return phone ? { phone } : null;
}
