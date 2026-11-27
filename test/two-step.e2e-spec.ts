import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, Role } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { base32Decode, base32Encode, totpAt, verifyTotp } from '../src/auth/two-step/totp';
import { hashPassword } from '../src/common/password';
import { setupApp } from '../src/setup-app';
import { codeFor } from './helpers/two-step';

describe('TOTP (RFC 6238)', () => {
  // RFC 6238 appendix B, SHA-1, secret "12345678901234567890"; the last six digits of the eight-digit values.
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('at %i seconds gives %s', (t, code) => {
    expect(totpAt(secret, Math.floor(t / 30))).toBe(code);
  });

  it('round-trips base32 and allows one step of clock drift, but not two, and never an old step again', () => {
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    const now = 1111111111 * 1000;
    const step = Math.floor(now / 30000);
    expect(verifyTotp(secret, totpAt(secret, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(secret, totpAt(secret, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(secret, totpAt(secret, step + 2), now)).toBeNull();
    expect(verifyTotp(secret, totpAt(secret, step), now, step)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now)).toBeNull();
  });
});

describe('Two-step sign-in (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const cookieFrom = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[] | undefined)?.find((c) => c.startsWith('eduos_rt='))?.split(';')[0];
  const login = (identifier: string, password: string) => http().post('/auth/login').send({ identifier, password });
  const code = (mfaToken: string, c: string) => http().post('/auth/login/code').send({ mfaToken, code: c });

  let adminSecret: string;
  let adminRecovery: string[];
  let admin: string;
  const ADMIN_PW = 'calm-harbour-stone-26';

  beforeAll(async () => {
    process.env.COOKIE_SECURE = 'false';
    process.env.LOGIN_RATE_LIMIT = '1000';
    prisma = new PrismaClient();
    await prisma.$executeRawUnsafe(
      'TRUNCATE "MfaChallenge", "RecoveryCode", "Notice", "Notification", "DeviceToken", "SmsMessage", "Holiday", "AuditLog", "RefreshToken", "Transfer", "StudentGuardian", "ClassPlacement", "Enrolment", "Student", "ClassArm", "AcademicSession", "Counter", "User", "School" CASCADE',
    );
    await prisma.user.create({
      data: { fullName: 'Ministry Admin', email: 'admin@moe.test', role: Role.MINISTRY_ADMIN, passwordHash: await hashPassword('Temp1234x'), mustChangePassword: true },
    });
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    setupApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('makes a Ministry administrator set up two-step sign-in before doing anything else', async () => {
    const first = await login('admin@moe.test', 'Temp1234x').expect(200);
    const changed = await http().post('/auth/change-password').set(bearer(first.body.accessToken)).send({ currentPassword: 'Temp1234x', newPassword: ADMIN_PW }).expect(200);
    expect(changed.body.user).toMatchObject({ twoStepRequired: true, twoStepEnabled: false });
    const pending = changed.body.accessToken;

    const blocked = await http().get('/users').set(bearer(pending)).expect(403);
    expect(blocked.body.code).toBe('TWO_STEP_SETUP_REQUIRED');
    await http().get('/auth/me').set(bearer(pending)).expect(200);
    expect((await http().get('/auth/two-step').set(bearer(pending)).expect(200)).body).toMatchObject({ enabled: false, required: true });

    const setup = await http().post('/auth/two-step/setup').set(bearer(pending)).expect(200);
    adminSecret = setup.body.secret;
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\/Osun%20EduOS%3Aadmin%40moe\.test\?secret=/);
    expect(setup.body.qrSvg).toMatch(/^<svg/);

    // The secret is stored encrypted, never as the code the app was given.
    const row = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@moe.test' } });
    expect(row.totpPendingSecret).toMatch(/^v1\./);
    expect(row.totpPendingSecret).not.toContain(adminSecret);

    await http().post('/auth/two-step/confirm').set(bearer(pending)).send({ code: '000000' }).expect(400);
    const done = await http().post('/auth/two-step/confirm').set(bearer(pending)).send({ code: codeFor(adminSecret) }).expect(200);
    adminRecovery = done.body.recoveryCodes;
    expect(adminRecovery).toHaveLength(10);
    expect(adminRecovery[0]).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    admin = done.body.accessToken;
    await http().get('/users').set(bearer(admin)).expect(200);
    // Switching it on ends the half-signed-in session.
    await http().post('/auth/refresh').set('Cookie', cookieFrom(changed)!).expect(401);
  });

  it('asks for a code after the password, and accepts each code only once', async () => {
    const first = await login('admin@moe.test', ADMIN_PW).expect(200);
    expect(first.body).toMatchObject({ mfaRequired: true });
    expect(first.body.accessToken).toBeUndefined();
    expect(cookieFrom(first)).toBeUndefined();

    const bad = await code(first.body.mfaToken, '123456').expect(401);
    expect(bad.body.message).toMatch(/code is not right/);
    const good = await code(first.body.mfaToken, codeFor(adminSecret, 1)).expect(200);
    expect(good.body.user.twoStepEnabled).toBe(true);
    await http().get('/users').set(bearer(good.body.accessToken)).expect(200);

    // The challenge is single use, and the same authenticator code cannot sign in again.
    await code(first.body.mfaToken, codeFor(adminSecret, 1)).expect(401);
    const again = await login('admin@moe.test', ADMIN_PW).expect(200);
    await code(again.body.mfaToken, codeFor(adminSecret, 1)).expect(401);

    // Refreshing keeps the two-step status of the session.
    const refreshed = await http().post('/auth/refresh').set('Cookie', cookieFrom(good)!).expect(200);
    await http().get('/users').set(bearer(refreshed.body.accessToken)).expect(200);
  });

  it('accepts a recovery code once', async () => {
    const a = await login('admin@moe.test', ADMIN_PW).expect(200);
    await code(a.body.mfaToken, adminRecovery[0].toLowerCase()).expect(200);
    const b = await login('admin@moe.test', ADMIN_PW).expect(200);
    await code(b.body.mfaToken, adminRecovery[0]).expect(401);
    expect((await http().get('/auth/two-step').set(bearer(admin)).expect(200)).body.recoveryCodesLeft).toBe(9);
    const logged = await prisma.auditLog.count({ where: { action: 'auth.recovery_code_used' } });
    expect(logged).toBe(1);
  });

  it('gives up on a challenge after five wrong codes and locks the account after repeated failures', async () => {
    await prisma.user.update({ where: { email: 'admin@moe.test' }, data: { failedLoginCount: 0 } });
    const c = await login('admin@moe.test', ADMIN_PW).expect(200);
    for (let i = 0; i < 4; i++) await code(c.body.mfaToken, '111111').expect(401);
    // The fifth wrong code also locks the account (five failures in a row).
    await code(c.body.mfaToken, '111111').expect(401);
    const locked = await login('admin@moe.test', ADMIN_PW);
    expect(locked.status).toBe(423);
    await code(c.body.mfaToken, codeFor(adminSecret)).expect(401);
    await prisma.user.update({ where: { email: 'admin@moe.test' }, data: { lockedUntil: null, failedLoginCount: 0 } });
  });

  it('expires the step between password and code', async () => {
    const c = await login('admin@moe.test', ADMIN_PW).expect(200);
    await prisma.mfaChallenge.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const r = await code(c.body.mfaToken, codeFor(adminSecret)).expect(401);
    expect(r.body.message).toMatch(/expired/);
  });

  it('does not let Ministry accounts turn it off, but lets others choose', async () => {
    const off = await http().post('/auth/two-step/disable').set(bearer(admin)).send({ password: ADMIN_PW, code: codeFor(adminSecret, -1) });
    expect(off.status).toBe(403);

    const school = await prisma.school.create({ data: { code: 'OS/TS/0001', name: 'Two Step School', lga: 'Osogbo', level: 'PRIMARY', ownership: 'PUBLIC' } });
    await prisma.user.create({
      data: { fullName: 'Ada Teacher', email: 'ada@school.test', role: Role.TEACHER, schoolId: school.id, passwordHash: await hashPassword('quiet-river-lamp-26'), mustChangePassword: false },
    });
    const t = await login('ada@school.test', 'quiet-river-lamp-26').expect(200);
    expect(t.body.user).toMatchObject({ twoStepRequired: false, twoStepEnabled: false });
    const teacher = t.body.accessToken;
    await http().get('/auth/me').set(bearer(teacher)).expect(200);

    const setup = await http().post('/auth/two-step/setup').set(bearer(teacher)).expect(200);
    const on = await http().post('/auth/two-step/confirm').set(bearer(teacher)).send({ code: codeFor(setup.body.secret) }).expect(200);
    const second = await login('ada@school.test', 'quiet-river-lamp-26').expect(200);
    expect(second.body.mfaRequired).toBe(true);

    await http().post('/auth/two-step/disable').set(bearer(on.body.accessToken)).send({ password: 'wrong-password-here', code: codeFor(setup.body.secret, 1) }).expect(400);
    await http().post('/auth/two-step/disable').set(bearer(on.body.accessToken)).send({ password: 'quiet-river-lamp-26', code: codeFor(setup.body.secret, 1) }).expect(200);
    const plain = await login('ada@school.test', 'quiet-river-lamp-26').expect(200);
    expect(plain.body.accessToken).toEqual(expect.any(String));
  });

  it('lets a Ministry administrator reset someone who lost their phone, but not themselves', async () => {
    const created = await http().post('/users').set(bearer(admin)).send({ fullName: 'Bola Officer', email: 'bola@moe.test', role: 'MINISTRY_OFFICER' }).expect(201);
    const officerId = created.body.user.id;
    const first = await login('bola@moe.test', created.body.tempPassword).expect(200);
    const changed = await http().post('/auth/change-password').set(bearer(first.body.accessToken)).send({ currentPassword: created.body.tempPassword, newPassword: 'green-mango-tree-26' }).expect(200);
    const setup = await http().post('/auth/two-step/setup').set(bearer(changed.body.accessToken)).expect(200);
    const on = await http().post('/auth/two-step/confirm').set(bearer(changed.body.accessToken)).send({ code: codeFor(setup.body.secret) }).expect(200);

    const me = (await http().get('/auth/me').set(bearer(admin)).expect(200)).body.id;
    await http().post(`/users/${me}/reset-two-step`).set(bearer(admin)).expect(400);
    await http().post(`/users/${officerId}/reset-two-step`).set(bearer(on.body.accessToken)).expect(403);

    const reset = await http().post(`/users/${officerId}/reset-two-step`).set(bearer(admin)).expect(201);
    expect(reset.body.twoStepEnabled).toBe(false);
    expect(await prisma.recoveryCode.count({ where: { userId: officerId } })).toBe(0);
    await http().post('/auth/refresh').set('Cookie', cookieFrom(on)!).expect(401);

    // Signing in again goes straight to set-up.
    const back = await login('bola@moe.test', 'green-mango-tree-26').expect(200);
    expect(back.body.mfaRequired).toBeUndefined();
    expect((await http().get('/users').set(bearer(back.body.accessToken)).expect(403)).body.code).toBe('TWO_STEP_SETUP_REQUIRED');
    expect(await prisma.auditLog.count({ where: { action: 'user.two_step_reset' } })).toBe(1);
  });

  it('replaces recovery codes only with a current authenticator code', async () => {
    await http().post('/auth/two-step/recovery-codes').set(bearer(admin)).send({ code: adminRecovery[1] }).expect(400);
    // Earlier tests used up the codes around now; pretend a minute has passed.
    await prisma.user.update({ where: { email: 'admin@moe.test' }, data: { totpLastStep: Math.floor(Date.now() / 30000) - 2 } });
    const ok = await http().post('/auth/two-step/recovery-codes').set(bearer(admin)).send({ code: codeFor(adminSecret) }).expect(200);
    expect(ok.body.recoveryCodes).toHaveLength(10);
    const c = await login('admin@moe.test', ADMIN_PW).expect(200);
    await code(c.body.mfaToken, adminRecovery[2]).expect(401);
  });
});
