import { hash, verify } from '@node-rs/argon2';
import { createHash, randomInt } from 'crypto';

const ARGON_OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON_OPTS);
}

export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false;
  }
}

/** A hash to compare against when the account doesn't exist, so timing doesn't reveal it. */
let dummyHash: Promise<string> | null = null;
export function dummyVerify(plain: string): Promise<boolean> {
  dummyHash ??= hashPassword('not-a-real-password-0');
  return dummyHash.then((h) => verifyPassword(h, plain));
}

/**
 * Password rules, following NIST SP 800-63B: a minimum length, no forced mix of character types, and a check
 * against passwords that are common, about this service, or about the person.
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

/** Words that make a password easy to guess here. Checked after removing digits and symbols. */
const GUESSABLE = new Set([
  'password', 'passw', 'pass', 'qwerty', 'qwertyuiop', 'asdfgh', 'abc', 'abcdef', 'letmein', 'welcome', 'admin',
  'administrator', 'login', 'iloveyou', 'monkey', 'dragon', 'football', 'secret', 'changeme', 'default',
  'osun', 'osunstate', 'eduos', 'osuneduos', 'school', 'teacher', 'principal', 'parent', 'student', 'ministry',
  'education', 'nigeria', 'osogbo', 'oshogbo', 'temp', 'temporary',
]);

/** Parts of the person's own details that must not be the password: names, the e-mail's local part, the phone. */
export interface PasswordContext {
  fullName?: string | null;
  email?: string | null;
  phone?: string | null;
}

/** Collapses "abcabc" to "abc" so repeating a guessable word does not hide it. */
function unrepeat(s: string): string {
  for (let n = 1; n <= s.length / 2; n++) {
    if (s.length % n === 0 && s.slice(0, n).repeat(s.length / n) === s) return s.slice(0, n);
  }
  return s;
}

/** Rules for passwords people choose. Returns a reason, or null if it's acceptable. */
export function passwordProblem(pw: string, who: PasswordContext = {}): string | null {
  const length = [...pw].length;
  if (length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters. A short phrase of three or four words is easy to remember.`;
  if (length > MAX_PASSWORD_LENGTH) return `Use ${MAX_PASSWORD_LENGTH} characters or fewer.`;
  if (new Set(pw).size < 4) return 'Use more different characters.';

  const letters = pw.toLowerCase().normalize('NFKD').replace(/[^a-z]/g, '');
  if (letters.length < 4) return 'Use words, not just numbers or symbols.';
  const core = unrepeat(letters);
  const personal = [
    ...(who.fullName ?? '').toLowerCase().split(/[^a-z]+/),
    (who.email ?? '').toLowerCase().split('@')[0].replace(/[^a-z]/g, ''),
  ].filter((w) => w.length >= 3);
  if (GUESSABLE.has(core) || personal.includes(core) || personal.some((w) => core === unrepeat(w + w))) {
    return 'That password is too easy to guess. Avoid your name, the name of this service and common passwords.';
  }
  const digits = (who.phone ?? '').replace(/\D/g, '');
  if (digits.length >= 7 && pw.replace(/\D/g, '').includes(digits.slice(-7))) return 'Do not use your phone number in your password.';
  return null;
}

/**
 * Checks the Have I Been Pwned password list, which holds passwords exposed in data breaches. Only the first five
 * characters of the password's SHA-1 hash leave the server (k-anonymity), with padding so the response size gives
 * nothing away. If the service cannot be reached the check is skipped, so sign-in never depends on it.
 */
export async function isBreachedPassword(pw: string, timeoutMs = 3000): Promise<boolean | null> {
  if (process.env.PASSWORD_BREACH_CHECK === 'off') return null;
  const hash = createHash('sha1').update(pw, 'utf8').digest('hex').toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);
  try {
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'osun-eduos-api' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = await res.text();
    return body.split('\n').some((line) => {
      const [s, count] = line.trim().split(':');
      return s === suffix && Number(count) > 0;
    });
  } catch {
    return null;
  }
}

/** Temporary passwords: easy to read aloud or copy, no look-alike characters. */
export function generateTempPassword(length = 10): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  while (out.length < length) out += alphabet[randomInt(alphabet.length)];
  if (!/\d/.test(out)) out = out.slice(0, -1) + String(randomInt(2, 10));
  return out;
}
