import { createHash } from 'crypto';
import { generateTempPassword, isBreachedPassword, passwordProblem } from '../src/common/password';

/** Password rules (NIST SP 800-63B style) and the leaked-password check. */
describe('password rules', () => {
  it('asks for length, not a mix of character types', () => {
    expect(passwordProblem('short phrase')).toBeNull();
    expect(passwordProblem('quiet river lamp')).toBeNull();
    expect(passwordProblem('Abc123!')).toMatch(/at least 12/);
    expect(passwordProblem('x'.repeat(129) + 'abc')).toMatch(/128 characters or fewer/);
  });

  it('rejects passwords that are easy to guess', () => {
    expect(passwordProblem('aaaaaaaaaaaaaa')).toMatch(/different characters/);
    expect(passwordProblem('123456789012')).toMatch(/words/);
    expect(passwordProblem('Password2026!')).toMatch(/too easy/);
    expect(passwordProblem('OsunEduOS2026!')).toMatch(/too easy/);
    expect(passwordProblem('teacher!teacher!')).toMatch(/too easy/);
    expect(passwordProblem('Qwerty12345678')).toMatch(/too easy/);
  });

  it('rejects the person\'s own name, e-mail or phone number', () => {
    const who = { fullName: 'Adeola Ogunleye', email: 'deola.o@school.test', phone: '+2348031234567' };
    expect(passwordProblem('Ogunleye2026!!', who)).toMatch(/too easy/);
    expect(passwordProblem('deolao2026!!!!', who)).toMatch(/too easy/);
    expect(passwordProblem('mango 08031234567', who)).toMatch(/phone number/);
    expect(passwordProblem('Adeola likes mangoes', who)).toBeNull();
  });

  it('accepts the temporary passwords the system generates once changed', () => {
    for (let i = 0; i < 50; i++) expect(generateTempPassword(10)).toMatch(/^[A-Za-z2-9]{10}$/);
  });
});

describe('leaked-password check', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    process.env.PASSWORD_BREACH_CHECK = 'off';
  });

  function fakeRange(pw: string, count: number) {
    const hash = createHash('sha1').update(pw).digest('hex').toUpperCase();
    const calls: string[] = [];
    global.fetch = jest.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(`0000000000000000000000000000000000A:0\r\n${hash.slice(5)}:${count}\r\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:3`);
    }) as typeof fetch;
    return { calls, prefix: hash.slice(0, 5) };
  }

  it('sends only the first five characters of the hash and spots a leaked password', async () => {
    process.env.PASSWORD_BREACH_CHECK = 'on';
    const { calls, prefix } = fakeRange('correct horse battery', 42);
    await expect(isBreachedPassword('correct horse battery')).resolves.toBe(true);
    expect(calls).toEqual([`https://api.pwnedpasswords.com/range/${prefix}`]);
  });

  it('ignores padding entries with a count of zero', async () => {
    process.env.PASSWORD_BREACH_CHECK = 'on';
    fakeRange('quiet river lamp', 0);
    await expect(isBreachedPassword('quiet river lamp')).resolves.toBe(false);
  });

  it('does not block anyone when the service cannot be reached', async () => {
    process.env.PASSWORD_BREACH_CHECK = 'on';
    global.fetch = jest.fn(async () => { throw new Error('offline'); }) as typeof fetch;
    await expect(isBreachedPassword('quiet river lamp')).resolves.toBeNull();
  });

  it('can be turned off', async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    await expect(isBreachedPassword('quiet river lamp')).resolves.toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
