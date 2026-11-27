import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * Encrypts authenticator secrets before they are stored (AES-256-GCM), so a copy of the database alone is not
 * enough to generate someone's codes. The key comes from MFA_ENCRYPTION_KEY: 32 random bytes, base64-encoded.
 */
export function loadMfaKey(raw: string | undefined): Buffer {
  const key = Buffer.from((raw ?? '').trim(), 'base64');
  if (key.length !== 32) throw new Error('MFA_ENCRYPTION_KEY must be 32 random bytes, base64-encoded. Run `npm run keys` to make one.');
  return key;
}

export function seal(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

export function open(key: Buffer, sealed: string): string {
  const [v, iv, tag, body] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || !body) throw new Error('Unreadable two-step secret.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}
