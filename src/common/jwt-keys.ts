import { createHash, createPrivateKey, createPublicKey, KeyObject } from 'crypto';

/**
 * Access tokens are signed with ES256 (ECDSA on P-256). eduos-api holds the private key; eduos-sync and anything
 * else that checks tokens gets only the public key, so a leak there cannot be used to forge a sign-in.
 */
export interface SigningKeys {
  privateKey: string;
  publicKey: string;
  /** Identifies the key in each token's header, so keys can be rotated later. */
  keyId: string;
}

/** Accepts a PEM block as it usually arrives in an environment variable: as is, with "\n" escaped, or base64. */
export function readPem(raw: string): string {
  let s = raw.trim();
  if (!s.startsWith('-----BEGIN')) {
    const decoded = Buffer.from(s, 'base64').toString('utf8').trim();
    if (decoded.startsWith('-----BEGIN')) s = decoded;
  }
  return s.replace(/\\n/g, '\n');
}

export function loadSigningKeys(raw: string | undefined): SigningKeys {
  if (!raw?.trim()) {
    throw new Error('JWT_PRIVATE_KEY must be set to an ES256 (P-256) private key. Run `npm run keys` to make one.');
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(readPem(raw));
  } catch {
    throw new Error('JWT_PRIVATE_KEY is not a valid private key in PEM form.');
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('JWT_PRIVATE_KEY must be an EC key on the P-256 curve (ES256).');
  }
  const pub = createPublicKey(key);
  const der = pub.export({ type: 'spki', format: 'der' });
  return {
    privateKey: key.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: pub.export({ type: 'spki', format: 'pem' }).toString(),
    keyId: createHash('sha256').update(der).digest('base64url').slice(0, 16),
  };
}
