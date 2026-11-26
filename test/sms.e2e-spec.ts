import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, Role } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/common/password';
import { setupApp } from '../src/setup-app';
import { KudiSmsProvider, LogProvider } from '../src/sms/providers';
import { absenceText, SmsService } from '../src/sms/sms.service';

describe('KudiSMS client', () => {
  const fake = (status: number, body: unknown, seen: { url?: string; body?: Record<string, unknown> } = {}) =>
    (async (url: string, init: RequestInit) => {
      seen.url = url;
      seen.body = JSON.parse(String(init.body));
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }) as unknown as typeof fetch;

  it('sends on the corporate route without a plus sign, and reads the message id and cost', async () => {
    const seen: { url?: string; body?: Record<string, unknown> } = {};
    const k = new KudiSmsProvider({ token: 't0k', senderId: 'OsunEdu', route: 'corporate' }, fake(200, { status: 'success', error_code: '000', cost: '3.50', data: '2348031112222|abc-123', msg: 'ok' }, seen));
    expect(await k.send('+2348031112222', 'Hello')).toEqual({ ok: true, providerId: 'abc-123', cost: '3.50' });
    expect(seen.url).toBe('https://my.kudisms.net/api/corporate');
    expect(seen.body).toEqual({ token: 't0k', senderID: 'OsunEdu', recipients: '2348031112222', message: 'Hello' });
  });

  it('uses the DND-refund gateway on the bulk route', async () => {
    const seen: { url?: string; body?: Record<string, unknown> } = {};
    const k = new KudiSmsProvider({ token: 't', senderId: 'S', route: 'sms' }, fake(200, { status: 'success', error_code: '000', data: ['234803|id-9'] }, seen));
    expect((await k.send('+234803', 'x')).providerId).toBe('id-9');
    expect(seen.url).toMatch(/\/api\/sms$/);
    expect(seen.body?.gateway).toBe('2');
  });

  it('does not retry refusals, but retries outages', async () => {
    const bad = new KudiSmsProvider({ token: 't', senderId: 'S', route: 'corporate' }, fake(401, { status: 'error', error_code: '100', msg: 'Token provided is invalid.' }));
    expect(await bad.send('+234803', 'x')).toMatchObject({ ok: false, retry: false, error: expect.stringMatching(/100: Token provided is invalid/) });
    const poor = new KudiSmsProvider({ token: 't', senderId: 'S', route: 'corporate' }, fake(200, { status: 'error', error_code: '109', msg: 'Insufficient credit' }));
    expect(await poor.send('+234803', 'x')).toMatchObject({ ok: false, retry: true });
    const down = new KudiSmsProvider({ token: 't', senderId: 'S', route: 'corporate' }, (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch);
    expect(await down.send('+234803', 'x')).toMatchObject({ ok: false, retry: true, error: expect.stringMatching(/could not be reached/) });
    const html = new KudiSmsProvider({ token: 't', senderId: 'S', route: 'corporate' }, fake(502, '<html>Bad gateway</html>'));
    expect(await html.send('+234803', 'x')).toMatchObject({ ok: false, retry: true });
  });

  it('writes a short absence text', () => {
    const t = absenceText({ firstName: 'Kemi', surname: 'Bello' }, 'Ilesa Grammar School', new Date('2026-11-25T00:00:00Z'));
    expect(t).toBe('Kemi Bello was marked absent at Ilesa Grammar School today, Wed 25 Nov. If this is unexpected, please contact the school. - Osun EduOS');
    expect(t.length).toBeLessThanOrEqual(160);
  });
});

/** Absence texts end to end. Registers can only be taken on weekdays, so this part runs Monday to Friday. Erases the test database first. */
const lagos = new Date(Date.now() + 3_600_000);
const weekday = ![0, 6].includes(lagos.getUTCDay());
(weekday ? describe : describe.skip)('Absence texts (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let sms: SmsService;
  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    get: (url: string) => http().get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => http().post(url).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    put: (url: string, body: object) => http().put(url).set('Authorization', `Bearer ${token}`).send(body),
    patch: (url: string, body: object) => http().patch(url).set('Authorization', `Bearer ${token}`).send(body),
  });
  async function activate(identifier: string, temp: string) {
    const first = await http().post('/auth/login').send({ identifier, password: temp }).expect(200);
    const r = await http().post('/auth/change-password').set('Authorization', `Bearer ${first.body.accessToken}`).send({ currentPassword: temp, newPassword: 'Permanent2026' }).expect(200);
    return r.body.accessToken as string;
  }
  const today = lagos.toISOString().slice(0, 10);
  const iso = (o: number) => new Date(Date.parse(today) + o * 86_400_000).toISOString().slice(0, 10);
  let ministry: ReturnType<typeof as>;
  let school: ReturnType<typeof as>;
  let teacher: ReturnType<typeof as>;
  let cls: string;
  let ada: string;
  let bayo: string;
  let chi: string;
  const sent = () => (sms.provider as LogProvider).sent;

  beforeAll(async () => {
    prisma = new PrismaClient();
    process.env.COOKIE_SECURE = 'false';
    process.env.LOGIN_RATE_LIMIT = '1000';
    process.env.JWT_ACCESS_SECRET ??= 'test-secret-test-secret-test-secret-123';
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Notice", "Notification", "DeviceToken", "SmsMessage", "Holiday", "SyncEvent", "Score", "ScoreSheet", "ClassSubject", "ClassResult", "ReportRemark", "Term", "AttendanceMark", "AttendanceRegister", "AuditLog", "RefreshToken", "Transfer", "StudentGuardian", "ClassPlacement", "Enrolment", "Student", "ClassArm", "AcademicSession", "Counter", "User", "School" CASCADE',
    );
    await prisma.user.create({ data: { fullName: 'Ministry Admin', email: 'admin@moe.test', role: Role.MINISTRY_ADMIN, passwordHash: await hashPassword('Temp1234x') } });
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    setupApp(app);
    await app.init();
    sms = app.get(SmsService);
    ministry = as(await activate('admin@moe.test', 'Temp1234x'));
    await ministry.post('/sessions', { name: '2070/2071', startDate: iso(-60), endDate: iso(200) }).expect(201);
    const a = await ministry.post('/schools', { name: 'Ede Muslim High School', lga: 'Ede North', level: 'JUNIOR_AND_SENIOR', ownership: 'PUBLIC', admin: { fullName: 'Head', email: 'h@x.test' } }).expect(201);
    school = as(await activate('h@x.test', a.body.admin.tempPassword));
    const t = await school.post('/users', { fullName: 'Teacher T', email: 't@x.test', role: 'TEACHER' }).expect(201);
    teacher = as(await activate('t@x.test', t.body.tempPassword));
    cls = (await school.post('/classes', { level: 'JSS_1', arm: 'A', classTeacherId: t.body.user.id }).expect(201)).body.id;
    const enrol = async (first: string, guardian?: object) =>
      (await school.post('/students', { surname: 'Ola', firstName: first, sex: 'F', dateOfBirth: '2014-01-01', classArmId: cls, admittedOn: iso(-30), guardian }).expect(201)).body.student.id as string;
    ada = await enrol('Ada', { relationship: 'Mother', newParent: { fullName: 'Mrs Ola', phone: '08031112222' } });
    bayo = await enrol('Bayo', { relationship: 'Father', newParent: { fullName: 'Mr Email Only', email: 'dad@x.test' } });
    chi = await enrol('Chi');
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  const register = (marks: Record<string, string>) =>
    teacher.put('/attendance/register', { classId: cls, date: today, marks: Object.entries(marks).map(([studentId, status]) => ({ studentId, status })) }).expect(200);

  it('texts a parent with a phone once when their child is marked absent today', async () => {
    // Enrolment confirmations are covered in parity.e2e-spec; set them aside here.
    await prisma.smsMessage.deleteMany({ where: { kind: 'ENROLMENT' } });
    await prisma.notification.deleteMany({ where: { kind: 'ENROLMENT' } });
    await register({ [ada]: 'ABSENT', [bayo]: 'ABSENT', [chi]: 'ABSENT' });
    await register({ [ada]: 'ABSENT', [bayo]: 'ABSENT', [chi]: 'ABSENT' });
    expect(await prisma.smsMessage.count({ where: { kind: 'ABSENCE' } })).toBe(1); // Bayo's parent has no phone; Chi has no parent.
    // Both parents see it in their inbox, phone or not, once.
    const inbox = await prisma.notification.findMany({ where: { kind: 'ABSENCE' }, include: { user: true }, orderBy: { title: 'asc' } });
    expect(inbox.map((n) => [n.user.fullName, n.title])).toEqual([['Mrs Ola', 'Ada was absent today'], ['Mr Email Only', 'Bayo was absent today']]);
    expect(await sms.sendDue()).toBe(1);
    expect(sent()).toEqual([{ to: '+2348031112222', body: expect.stringMatching(/^Ada Ola was marked absent at Ede Muslim High School today/) }]);
    await register({ [ada]: 'ABSENT', [bayo]: 'PRESENT', [chi]: 'PRESENT' });
    expect(await sms.sendDue()).toBe(0);
    expect(sent()).toHaveLength(1);
  });

  it('cancels a queued text when the register is corrected before it is sent, and requeues it if absent again', async () => {
    await prisma.smsMessage.deleteMany();
    await register({ [ada]: 'ABSENT', [bayo]: 'PRESENT', [chi]: 'PRESENT' });
    await register({ [ada]: 'LATE', [bayo]: 'PRESENT', [chi]: 'PRESENT' });
    expect((await prisma.smsMessage.findFirstOrThrow()).status).toBe('CANCELLED');
    await register({ [ada]: 'ABSENT', [bayo]: 'PRESENT', [chi]: 'PRESENT' });
    expect((await prisma.smsMessage.findFirstOrThrow()).status).toBe('QUEUED');
  });

  it('lets the school switch absence texts off, which cancels what is waiting', async () => {
    const s = await school.get('/sms/summary').expect(200);
    expect(s.body).toMatchObject({ absenceSms: true, provider: 'log', sending: false, today: { QUEUED: 1 } });
    await school.patch('/sms/settings', { absenceSms: false }).expect(200);
    expect((await prisma.smsMessage.findFirstOrThrow()).status).toBe('CANCELLED');
    await register({ [ada]: 'ABSENT', [bayo]: 'PRESENT', [chi]: 'PRESENT' });
    expect((await prisma.smsMessage.findFirstOrThrow()).status).toBe('CANCELLED');
    await school.patch('/sms/settings', { absenceSms: true }).expect(200);
  });

  it('shows the log to the school and the Ministry only, and lets the Ministry send a test', async () => {
    await teacher.get('/sms').expect(403);
    const log = await school.get('/sms').expect(200);
    expect(log.body[0]).toMatchObject({ student: 'Ola Ada', parent: 'Mrs Ola', school: 'Ede Muslim High School', kind: 'ABSENCE' });
    await school.post('/sms/test', { phone: '08031112222' }).expect(403);
    await ministry.post('/sms/test', { phone: '123' }).expect(400);
    expect((await ministry.post('/sms/test', { phone: '08035550000' }).expect(201)).body).toEqual({ ok: true, provider: 'log', error: null });
    expect((await ministry.get('/sms').expect(200)).body.some((m: { kind: string }) => m.kind === 'TEST')).toBe(true);
  });

  it('gives up on texts that were not sent on the day', async () => {
    await prisma.smsMessage.updateMany({ data: { status: 'QUEUED', date: new Date(iso(-1)), sendAfter: new Date(0) }, where: { kind: 'ABSENCE' } });
    await sms.sendDue();
    expect((await prisma.smsMessage.findFirstOrThrow({ where: { kind: 'ABSENCE' } })).status).toBe('CANCELLED');
  });
});
