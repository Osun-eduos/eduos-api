import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, Role } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { createHmac, generateKeyPairSync, sign } from 'crypto';
import { loadSigningKeys } from '../src/common/jwt-keys';
import { hashPassword } from '../src/common/password';
import { setupApp } from '../src/setup-app';

/**
 * End-to-end tests for accounts and sign-in. Needs a disposable PostgreSQL database in
 * DATABASE_URL (for example eduos_test) with migrations applied.
 */
describe('Accounts and sign-in (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  const http = () => request(app.getHttpServer());

  const cookieFrom = (res: request.Response) => {
    const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
    const c = raw?.find((x) => x.startsWith('eduos_rt='));
    return c ? c.split(';')[0] : undefined;
  };

  function login(identifier: string, password: string) {
    return http().post('/auth/login').send({ identifier, password });
  }

  /** Signs in with a temporary password, sets a permanent one and returns a usable access token. */
  async function activate(identifier: string, temp: string, permanent: string) {
    const first = await login(identifier, temp).expect(200);
    expect(first.body.user.mustChangePassword).toBe(true);
    const changed = await http()
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${first.body.accessToken}`)
      .send({ currentPassword: temp, newPassword: permanent })
      .expect(200);
    expect(changed.body.user.mustChangePassword).toBe(false);
    return changed.body.accessToken as string;
  }

  let ministry: string;
  let schoolId: string;
  let schoolAdmin: string;
  let teacherId: string;

  beforeAll(async () => {
    process.env.COOKIE_SECURE = 'false';
    process.env.LOGIN_RATE_LIMIT = '1000';
    prisma = new PrismaClient();
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Notice", "Notification", "DeviceToken", "SmsMessage", "Holiday", "AuditLog", "RefreshToken", "Transfer", "StudentGuardian", "ClassPlacement", "Enrolment", "Student", "ClassArm", "AcademicSession", "Counter", "User", "School" CASCADE',
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

  it('rejects wrong passwords without revealing whether the account exists', async () => {
    const a = await login('admin@moe.test', 'nope').expect(401);
    const b = await login('nobody@moe.test', 'nope').expect(401);
    expect(a.body.message).toBe(b.body.message);
  });

  it('forces a password change on first sign-in', async () => {
    const first = await login('ADMIN@moe.test', 'Temp1234x').expect(200);
    await http().get('/users').set('Authorization', `Bearer ${first.body.accessToken}`).expect(403);
    await http().get('/auth/me').set('Authorization', `Bearer ${first.body.accessToken}`).expect(200);
    await http()
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${first.body.accessToken}`)
      .send({ currentPassword: 'Temp1234x', newPassword: 'short' })
      .expect(400);
    ministry = await activate('admin@moe.test', 'Temp1234x', 'calm-harbour-stone-26');
    await http().get('/users').set('Authorization', `Bearer ${ministry}`).expect(200);
  });

  it('lets the Ministry register a school with its administrator', async () => {
    const res = await http()
      .post('/schools')
      .set('Authorization', `Bearer ${ministry}`)
      .send({
        name: 'Osogbo Model Secondary School', lga: 'Osogbo', level: 'JUNIOR_AND_SENIOR', ownership: 'PUBLIC',
        admin: { fullName: 'Olufunke Adebisi', email: 'principal@omss.test' },
      })
      .expect(201);
    expect(res.body.school.code).toBe('OS/OSG/COM/0001');
    expect(res.body.admin.tempPassword).toHaveLength(10);
    schoolId = res.body.school.id;
    schoolAdmin = await activate('principal@omss.test', res.body.admin.tempPassword, 'green-mango-tree-26');

    const second = await http()
      .post('/schools')
      .set('Authorization', `Bearer ${ministry}`)
      .send({ name: 'Baptist High School', lga: 'Osogbo', level: 'JUNIOR_AND_SENIOR', ownership: 'PUBLIC' })
      .expect(201);
    expect(second.body.school.code).toBe('OS/OSG/COM/0002');
  });

  it('rejects an unknown LGA', async () => {
    await http()
      .post('/schools')
      .set('Authorization', `Bearer ${ministry}`)
      .send({ name: 'Nowhere School', lga: 'Lagos Island', level: 'PRIMARY', ownership: 'PUBLIC' })
      .expect(400);
  });

  it('lets a school create teachers and parents, signing in by email or phone', async () => {
    const t = await http()
      .post('/users')
      .set('Authorization', `Bearer ${schoolAdmin}`)
      .send({ fullName: 'Tunde Olaniyan', email: 'tunde@omss.test', role: 'TEACHER' })
      .expect(201);
    expect(t.body.user.schoolId).toBe(schoolId);
    teacherId = t.body.user.id;
    await activate('tunde@omss.test', t.body.tempPassword, 'quiet-river-lamp-26');

    const p = await http()
      .post('/users')
      .set('Authorization', `Bearer ${schoolAdmin}`)
      .send({ fullName: 'Bisi Adeleke', phone: '0803 412 5590', role: 'PARENT' })
      .expect(201);
    expect(p.body.user.phone).toBe('+2348034125590');
    await activate('+234 803 412 5590', p.body.tempPassword, 'yellow-kite-sky-26');
  });

  it('stops schools creating Ministry accounts or accounts in another school', async () => {
    await http()
      .post('/users')
      .set('Authorization', `Bearer ${schoolAdmin}`)
      .send({ fullName: 'Someone Else', email: 'x@moe.test', role: 'MINISTRY_OFFICER' })
      .expect(403);
    const other = await prisma.school.findFirstOrThrow({ where: { id: { not: schoolId } } });
    await http()
      .post('/users')
      .set('Authorization', `Bearer ${schoolAdmin}`)
      .send({ fullName: 'Other Teacher', email: 'other@x.test', role: 'TEACHER', schoolId: other.id })
      .expect(403);
  });

  it('keeps teachers and parents out of account management', async () => {
    const teacher = (await login('tunde@omss.test', 'quiet-river-lamp-26').expect(200)).body.accessToken;
    await http().get('/users').set('Authorization', `Bearer ${teacher}`).expect(403);
    await http()
      .post('/users')
      .set('Authorization', `Bearer ${teacher}`)
      .send({ fullName: 'Sneaky Parent', email: 'sneaky@x.test', role: 'PARENT' })
      .expect(403);
    const parent = (await login('08034125590', 'yellow-kite-sky-26').expect(200)).body;
    expect(parent.user.role).toBe('PARENT');
    await http().get('/schools').set('Authorization', `Bearer ${parent.accessToken}`).expect(403);
  });

  it('refuses duplicate email addresses', async () => {
    await http()
      .post('/users')
      .set('Authorization', `Bearer ${schoolAdmin}`)
      .send({ fullName: 'Duplicate Tunde', email: 'TUNDE@omss.test', role: 'TEACHER' })
      .expect(409);
  });

  it('shows a school only its own accounts', async () => {
    const res = await http().get('/users').set('Authorization', `Bearer ${schoolAdmin}`).expect(200);
    expect(res.body.every((u: { schoolId: string }) => u.schoolId === schoolId)).toBe(true);
    expect(res.body.map((u: { role: string }) => u.role).sort()).toEqual(['PARENT', 'SCHOOL_ADMIN', 'TEACHER']);
  });

  it('locks an account after 5 failed attempts, and a reset unlocks it', async () => {
    for (let i = 0; i < 5; i++) await login('tunde@omss.test', 'wrong-password').expect(401);
    await login('tunde@omss.test', 'quiet-river-lamp-26').expect(423);
    const reset = await http().post(`/users/${teacherId}/reset-password`).set('Authorization', `Bearer ${schoolAdmin}`).expect(201);
    await activate('tunde@omss.test', reset.body.tempPassword, 'quiet-river-lamp-27');
  });

  it('rotates refresh tokens and ends every session when an old one is reused', async () => {
    const res = await login('principal@omss.test', 'green-mango-tree-26').expect(200);
    const c1 = cookieFrom(res)!;
    expect(c1).toBeDefined();
    const r2 = await http().post('/auth/refresh').set('Cookie', c1).expect(200);
    const c2 = cookieFrom(r2)!;
    expect(c2).not.toBe(c1);
    // A second tab refreshing with the same cookie a moment later is allowed.
    await http().post('/auth/refresh').set('Cookie', c1).expect(200);
    // Reuse after the grace period is treated as theft: every session for the account ends.
    await prisma.refreshToken.updateMany({ where: { revokedAt: { not: null } }, data: { revokedAt: new Date(Date.now() - 60_000) } });
    await http().post('/auth/refresh').set('Cookie', c1).expect(401);
    await http().post('/auth/refresh').set('Cookie', c2).expect(401);
  });

  it('signs access tokens with ES256 and rejects tokens signed any other way', async () => {
    const [h, p] = ministry.split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    expect(header.alg).toBe('ES256');
    expect(header.kid).toEqual(expect.any(String));
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const me = (token: string) => http().get('/auth/me').set('Authorization', `Bearer ${token}`);
    await me(ministry).expect(200);

    // The classic forgery: an HMAC "signature" made with the server's public key as the secret.
    const { publicKey } = loadSigningKeys(process.env.JWT_PRIVATE_KEY);
    const hsBody = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}`;
    await me(`${hsBody}.${createHmac('sha256', publicKey).update(hsBody).digest('base64url')}`).expect(401);

    // A token signed by some other key pair.
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    const esBody = `${b64(header)}.${b64(claims)}`;
    const forged = sign('sha256', Buffer.from(esBody), { key: other, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    await me(`${esBody}.${forged}`).expect(401);

    // No signature at all.
    await me(`${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.`).expect(401);
  });

  it('gives native apps the refresh token in the body instead of a cookie', async () => {
    const mobile = () => ({ 'X-Client': 'mobile' });
    const res = await http().post('/auth/login').set(mobile()).send({ identifier: 'principal@omss.test', password: 'green-mango-tree-26' }).expect(200);
    expect(cookieFrom(res)).toBeUndefined();
    expect(res.body.refreshToken).toEqual(expect.any(String));
    expect(res.body.accessToken).toEqual(expect.any(String));
    const r2 = await http().post('/auth/refresh').set(mobile()).send({ refreshToken: res.body.refreshToken }).expect(200);
    expect(r2.body.refreshToken).not.toBe(res.body.refreshToken);
    expect(cookieFrom(r2)).toBeUndefined();
    await http().post('/auth/refresh').set(mobile()).send({}).expect(401);
    await http().post('/auth/logout').set(mobile()).send({ refreshToken: r2.body.refreshToken }).expect(204);
    await http().post('/auth/refresh').set(mobile()).send({ refreshToken: r2.body.refreshToken }).expect(401);
    // A body token is ignored by the cookie-based web flow.
    await http().post('/auth/refresh').send({ refreshToken: res.body.refreshToken }).expect(401);
  });

  it('blocks sign-in for deactivated accounts and schools', async () => {
    await http().patch(`/users/${teacherId}`).set('Authorization', `Bearer ${schoolAdmin}`).send({ isActive: false }).expect(200);
    const blocked = await login('tunde@omss.test', 'quiet-river-lamp-27').expect(403);
    expect(blocked.body.code).toBe('ACCOUNT_INACTIVE');
    await http().patch(`/users/${teacherId}`).set('Authorization', `Bearer ${schoolAdmin}`).send({ isActive: true }).expect(200);
    await login('tunde@omss.test', 'quiet-river-lamp-27').expect(200);

    await http().patch(`/schools/${schoolId}`).set('Authorization', `Bearer ${ministry}`).send({ isActive: false }).expect(200);
    await login('tunde@omss.test', 'quiet-river-lamp-27').expect(403);
    await http().patch(`/schools/${schoolId}`).set('Authorization', `Bearer ${ministry}`).send({ isActive: true }).expect(200);
  });

  it('records activity in the audit log, scoped by school', async () => {
    const all = await http().get('/audit').set('Authorization', `Bearer ${ministry}`).expect(200);
    const actions = all.body.map((a: { action: string }) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['school.created', 'user.created', 'auth.account_locked', 'user.password_reset', 'auth.refresh_reuse_detected']));
    const mine = await http().get('/audit').set('Authorization', `Bearer ${schoolAdmin}`).expect(200);
    expect(mine.body.every((a: { schoolId: string | null }) => a.schoolId === schoolId)).toBe(true);
  });

  it('returns home-screen counts for the signed-in user', async () => {
    const m = await http().get('/stats').set('Authorization', `Bearer ${ministry}`).expect(200);
    expect(m.body.schools).toBe(2);
    expect(m.body.accountsByRole.TEACHER).toBe(1);
    const s = await http().get('/stats').set('Authorization', `Bearer ${schoolAdmin}`).expect(200);
    expect(s.body.schools).toBeNull();
    expect(s.body.accountsByRole.MINISTRY_ADMIN).toBe(0);
  });
});
