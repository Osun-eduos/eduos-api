import { generateKeyPairSync, createVerify } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, Role } from '@prisma/client';
import request from 'supertest';
import { completeTwoStep } from './helpers/two-step';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/common/password';
import { NotificationsService } from '../src/notifications/notifications.service';
import { FcmProvider, MemoryPush, readServiceAccount } from '../src/notifications/push';
import { setupApp } from '../src/setup-app';
import { SmsService } from '../src/sms/sms.service';

describe('Firebase push sender', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const account = { project_id: 'osun-eduos', client_email: 'push@osun-eduos.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };

  it('reads the service account as JSON or base64', () => {
    expect(readServiceAccount(JSON.stringify(account))?.project_id).toBe('osun-eduos');
    expect(readServiceAccount(Buffer.from(JSON.stringify(account)).toString('base64'))?.client_email).toBe(account.client_email);
    expect(readServiceAccount('{"project_id":"x"}')).toBeNull();
    expect(readServiceAccount('')).toBeNull();
  });

  it('signs in with a signed token once, sends, and spots uninstalled apps', async () => {
    const calls: { url: string; body: string; auth?: string }[] = [];
    const http = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body), auth: (init.headers as Record<string, string>)?.Authorization });
      if (url.includes('oauth2')) return new Response(JSON.stringify({ access_token: 'g-token', expires_in: 3600 }), { status: 200 });
      if (String(init.body).includes('"token":"gone"')) return new Response(JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }), { status: 404 });
      return new Response('{"name":"projects/osun-eduos/messages/1"}', { status: 200 });
    }) as unknown as typeof fetch;
    const fcm = new FcmProvider(account, http);
    expect(await fcm.send('phone-1', { title: 'Report card ready', body: 'Ada', data: { link: '/x' } })).toEqual({ ok: true });
    expect(await fcm.send('gone', { title: 't', body: 'b' })).toMatchObject({ ok: false, gone: true });
    expect(calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(1);
    const assertion = new URLSearchParams(calls[0].body).get('assertion')!;
    const [h, c, sig] = assertion.split('.');
    expect(JSON.parse(Buffer.from(c, 'base64url').toString())).toMatchObject({ iss: account.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token' });
    expect(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, 'base64url'))).toBe(true);
    expect(calls[1]).toMatchObject({ url: 'https://fcm.googleapis.com/v1/projects/osun-eduos/messages:send', auth: 'Bearer g-token' });
    expect(JSON.parse(calls[1].body).message).toMatchObject({ token: 'phone-1', notification: { title: 'Report card ready', body: 'Ada' }, data: { link: '/x' } });
  });
});

/** School notices, the inbox and push delivery. Erases the test database first. */
describe('Notices and the inbox (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let push: MemoryPush;
  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    get: (url: string) => http().get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => http().post(url).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    del: (url: string) => http().delete(url).set('Authorization', `Bearer ${token}`),
    patch: (url: string, body: object) => http().patch(url).set('Authorization', `Bearer ${token}`).send(body),
  });
  async function activate(identifier: string, temp: string) {
    const first = await http().post('/auth/login').send({ identifier, password: temp }).expect(200);
    const r = await http().post('/auth/change-password').set('Authorization', `Bearer ${first.body.accessToken}`).send({ currentPassword: temp, newPassword: 'steady-maple-road-26' }).expect(200);
    return completeTwoStep(http, r);
  }
  const today = new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);
  const iso = (o: number) => new Date(Date.parse(today) + o * 86_400_000).toISOString().slice(0, 10);
  let ministry: ReturnType<typeof as>;
  let school: ReturnType<typeof as>;
  let mum: ReturnType<typeof as>;
  let dad: ReturnType<typeof as>;
  let jss1: string;

  beforeAll(async () => {
    process.env.COOKIE_SECURE = 'false';
    process.env.LOGIN_RATE_LIMIT = '1000';
    prisma = new PrismaClient();
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Notice", "Notification", "DeviceToken", "SmsMessage", "Holiday", "SyncEvent", "Score", "ScoreSheet", "ClassSubject", "ClassResult", "ReportRemark", "Term", "AttendanceMark", "AttendanceRegister", "AuditLog", "RefreshToken", "Transfer", "StudentGuardian", "ClassPlacement", "Enrolment", "Student", "ClassArm", "AcademicSession", "Counter", "User", "School" CASCADE',
    );
    await prisma.user.create({ data: { fullName: 'Ministry Admin', email: 'admin@moe.test', role: Role.MINISTRY_ADMIN, passwordHash: await hashPassword('Temp1234x') } });
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    setupApp(app);
    await app.init();
    push = new MemoryPush();
    app.get(NotificationsService).push = push;
    ministry = as(await activate('admin@moe.test', 'Temp1234x'));
    await ministry.post('/sessions', { name: '2090/2091', startDate: iso(-60), endDate: iso(200) }).expect(201);
    const a = await ministry.post('/schools', { name: 'Ilesa Grammar School', lga: 'Ilesa East', level: 'JUNIOR_AND_SENIOR', ownership: 'PUBLIC', admin: { fullName: 'Head A', email: 'h@x.test' } }).expect(201);
    school = as(await activate('h@x.test', a.body.admin.tempPassword));
    jss1 = (await school.post('/classes', { level: 'JSS_1', arm: 'A' }).expect(201)).body.id;
    const jss2 = (await school.post('/classes', { level: 'JSS_2', arm: 'A' }).expect(201)).body.id;
    const k = await school.post('/students', { surname: 'Ola', firstName: 'Kemi', sex: 'F', dateOfBirth: '2014-01-01', classArmId: jss1, guardian: { relationship: 'Mother', newParent: { fullName: 'Mrs Ola', phone: '08031112222' } } }).expect(201);
    mum = as(await activate('08031112222', k.body.parent.tempPassword));
    const t = await school.post('/students', { surname: 'Ade', firstName: 'Tobi', sex: 'M', dateOfBirth: '2013-01-01', classArmId: jss2, guardian: { relationship: 'Father', newParent: { fullName: 'Mr Ade', email: 'dad@x.test' } } }).expect(201);
    dad = as(await activate('dad@x.test', t.body.parent.tempPassword));
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('sends a notice to every parent, or to one class, with an optional text', async () => {
    // Enrolment confirmations are covered in parity.e2e-spec; set them aside here.
    await prisma.smsMessage.deleteMany({ where: { kind: 'ENROLMENT' } });
    await prisma.notification.deleteMany({ where: { kind: 'ENROLMENT' } });
    const all = await school.post('/notices', { title: 'Inter-house sports', body: 'Sports day is on Friday. Pupils wear house colours.', sms: true }).expect(201);
    expect(all.body).toMatchObject({ audience: 'All parents', recipients: 2, texts: 1 });
    const one = await school.post('/notices', { title: 'JSS 1 excursion', body: 'Forms are due on Monday.', classArmId: jss1 }).expect(201);
    expect(one.body).toMatchObject({ audience: 'JSS 1A parents', recipients: 1, texts: 0 });

    const mine = (await mum.get('/notifications').expect(200)).body;
    expect(mine.unread).toBe(2);
    expect(mine.items.map((n: { title: string }) => n.title)).toEqual(expect.arrayContaining(['Inter-house sports', 'JSS 1 excursion']));
    expect(mine.items[0].body).toMatch(/^Ilesa Grammar School: /);
    expect((await dad.get('/notifications').expect(200)).body.items.map((n: { title: string }) => n.title)).toEqual(['Inter-house sports']);
    const text = await prisma.smsMessage.findFirstOrThrow({ where: { kind: 'NOTICE' } });
    expect(text).toMatchObject({ to: '+2348031112222', body: 'Ilesa Grammar School: Inter-house sports. Sports day is on Friday. Pupils wear house colours.' });
    expect((await school.get('/notices').expect(200)).body.map((n: { audience: string }) => n.audience)).toEqual(['JSS 1A parents', 'All parents']);
  });

  it('keeps texted notices short and limited, and only schools send notices', async () => {
    await school.post('/notices', { title: 'Long', body: 'x'.repeat(300), sms: true }).expect(400);
    await school.post('/notices', { title: 'Two', body: 'Second texted notice.', sms: true }).expect(201);
    await school.post('/notices', { title: 'Three', body: 'Third texted notice.', sms: true }).expect(201);
    const fourth = await school.post('/notices', { title: 'Four', body: 'Fourth texted notice.', sms: true }).expect(400);
    expect(fourth.body.message).toMatch(/3 notices by text today/);
    await school.post('/notices', { title: 'Four', body: 'Inbox only is fine.' }).expect(201);
    await ministry.post('/notices', { title: 'Hello', body: 'From the Ministry' }).expect(403);
    await mum.post('/notices', { title: 'Hello', body: 'From a parent' }).expect(403);
    await school.post('/notices', { title: 'Wrong class', body: 'Text', classArmId: '00000000-0000-4000-8000-000000000000' }).expect(400);
  });

  it('marks notifications read, one or all', async () => {
    const box = (await dad.get('/notifications').expect(200)).body;
    expect((await dad.post('/notifications/read', { ids: [box.items[0].id] }).expect(201)).body.unread).toBe(box.unread - 1);
    await dad.post('/notifications/read', { ids: ['not-a-uuid'] }).expect(400);
    expect((await dad.post('/notifications/read').expect(201)).body.unread).toBe(0);
    expect((await dad.get('/notifications/unread-count').expect(200)).body).toEqual({ unread: 0 });
    // Someone else's notification cannot be marked.
    const mumBox = (await mum.get('/notifications').expect(200)).body;
    await dad.post('/notifications/read', { ids: [mumBox.items[0].id] }).expect(201);
    expect((await mum.get('/notifications/unread-count').expect(200)).body.unread).toBe(mumBox.unread);
  });

  it('pushes new notifications to registered phones, once', async () => {
    await mum.post('/devices', { token: 'short', platform: 'android' }).expect(400);
    expect((await mum.post('/devices', { token: 'fcm-token-for-mums-phone-0001', platform: 'android' }).expect(201)).body).toEqual({ ok: true, push: true });
    await prisma.notification.updateMany({ data: { pushedAt: new Date() } });
    await school.post('/notices', { title: 'Open day', body: 'Parents are welcome on Saturday.' }).expect(201);
    const svc = app.get(NotificationsService);
    expect(await svc.pushDue()).toBe(1);
    expect(push.sent).toEqual([{ token: 'fcm-token-for-mums-phone-0001', m: expect.objectContaining({ title: 'Open day', body: 'Ilesa Grammar School: Parents are welcome on Saturday.' }) }]);
    expect(await svc.pushDue()).toBe(0);
    // A phone that signs in as someone else moves to them.
    await dad.post('/devices', { token: 'fcm-token-for-mums-phone-0001', platform: 'android' }).expect(201);
    expect((await prisma.deviceToken.findFirstOrThrow()).userId).toBe((await prisma.user.findFirstOrThrow({ where: { email: 'dad@x.test' } })).id);
    await dad.del('/devices/fcm-token-for-mums-phone-0001').expect(200);
    expect(await prisma.deviceToken.count()).toBe(0);
  });

  it('lets a school switch results texts off separately from absence texts', async () => {
    expect((await school.get('/sms/summary').expect(200)).body).toMatchObject({ absenceSms: true, resultsSms: true });
    expect((await school.patch('/sms/settings', { resultsSms: false }).expect(200)).body).toEqual({ absenceSms: true, resultsSms: false });
    await school.patch('/sms/settings', {}).expect(400);
    expect(app.get(SmsService)).toBeDefined();
  });
});
