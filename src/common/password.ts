import { hash, verify } from '@node-rs/argon2';
import { randomInt } from 'crypto';

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

/** Rules for passwords people choose. Returns a reason, or null if it's acceptable. */
export function passwordProblem(pw: string): string | null {
  if (pw.length < 8) return 'Use at least 8 characters.';
  if (pw.length > 128) return 'Use 128 characters or fewer.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Use at least one letter and one number.';
  return null;
}

/** Temporary passwords: easy to read aloud or copy, no look-alike characters. */
export function generateTempPassword(length = 10): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  while (out.length < length) out += alphabet[randomInt(alphabet.length)];
  if (!/\d/.test(out)) out = out.slice(0, -1) + String(randomInt(2, 10));
  return out;
}
