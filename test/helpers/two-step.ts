import request from 'supertest';
import { stepAt, totpAt } from '../../src/auth/two-step/totp';

type Http = () => ReturnType<typeof request>;

/** The current authenticator code for a secret, as the person's phone would show it. */
export const codeFor = (secret: string, offsetSteps = 0) => totpAt(secret, stepAt(Date.now()) + offsetSteps);

/**
 * After a password change: if the account's role requires two-step sign-in, sets it up the way a person would
 * (scan, type the code) and returns the new access token. Otherwise returns the token as is.
 */
export async function completeTwoStep(http: Http, res: request.Response): Promise<string> {
  const token = res.body.accessToken as string;
  if (!res.body.user?.twoStepRequired || res.body.user?.twoStepEnabled) return token;
  const setup = await http().post('/auth/two-step/setup').set('Authorization', `Bearer ${token}`).expect(200);
  const done = await http()
    .post('/auth/two-step/confirm')
    .set('Authorization', `Bearer ${token}`)
    .send({ code: codeFor(setup.body.secret) })
    .expect(200);
  return done.body.accessToken as string;
}
