// Makes a new ES256 key pair for access tokens and prints it in a form that pastes straight into environment settings.
// JWT_PRIVATE_KEY and MFA_ENCRYPTION_KEY go on eduos-api only. JWT_PUBLIC_KEY goes on eduos-sync (and anything else that checks tokens).
// Keep the private key secret: anyone who has it can sign in as anyone.
import { generateKeyPairSync, randomBytes } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const b64 = (s) => Buffer.from(s).toString('base64');
console.log(`JWT_PRIVATE_KEY=${b64(privateKey)}`);
console.log(`JWT_PUBLIC_KEY=${b64(publicKey)}`);
// Encrypts two-step sign-in secrets in the database. eduos-api only. Keep it: losing it switches off everyone's
// authenticator codes (they would have to set two-step sign-in up again).
console.log(`MFA_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`);
