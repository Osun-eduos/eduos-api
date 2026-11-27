// Tests send texts by calling the SMS service directly, never on a timer.
process.env.SMS_WORKER = 'off';
process.env.ABSENCE_SMS_DELAY_MINUTES = '0';
delete process.env.KUDISMS_TOKEN;
process.env.SMS_PROVIDER = 'log';
process.env.STORAGE_DRIVER = 'db';
// The leaked-password check calls an outside service; tests/passwords.e2e-spec.ts covers it with a fake response.
process.env.PASSWORD_BREACH_CHECK = 'off';
// A fresh ES256 key for each test run, unless one is supplied.
if (!process.env.JWT_PRIVATE_KEY) {
  const { generateKeyPairSync } = require('crypto');
  process.env.JWT_PRIVATE_KEY = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
}
