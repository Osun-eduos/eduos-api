import { looksLikeEmail } from '../src/common/identity';

describe('e-mail shape check', () => {
  it('accepts ordinary addresses and rejects malformed ones', () => {
    for (const ok of ['parent@example.com', 'a.b+c@school.edu.ng']) expect(looksLikeEmail(ok)).toBe(true);
    for (const bad of ['', 'parent', '@example.com', 'parent@', 'parent@example', 'parent@example.', 'a@b@c.com', 'pa rent@example.com']) {
      expect(looksLikeEmail(bad)).toBe(false);
    }
  });

  it('stays fast on long crafted input from a spreadsheet', () => {
    const started = Date.now();
    expect(looksLikeEmail('a@' + '.'.repeat(100_000) + '!')).toBe(false);
    expect(looksLikeEmail('a'.repeat(100_000) + '@x')).toBe(false);
    expect(Date.now() - started).toBeLessThan(50);
  });
});
