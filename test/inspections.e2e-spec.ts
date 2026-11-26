import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, Role } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { assess, checkAnswers } from '../src/common/inspection';
import { hashPassword } from '../src/common/password';
import { setupApp } from '../src/setup-app';

/** A good school, answer by answer. */
export const goodAnswers = () => ({
  classrooms: { total: 12, usable: 12, condition: 'GOOD', roofLeaks: false, enoughSeats: true, boards: 'GOOD' },
  toilets: { girls: 4, boys: 4, staff: 2, working: 10, condition: 'GOOD', handwashing: true },
  water: { source: 'BOREHOLE', working: true, safe: true },
  power: { source: 'SOLAR', working: true },
  safety: { fence: 'FULL', gate: true, firstAid: true, fireExtinguisher: true, hazards: false },
  facilities: { library: true, laboratory: false, ict: false, playground: true },
});

describe('Inspection checklist', () => {
  it('requires every answer, in range', () => {
    const a = goodAnswers() as Record<string, Record<string, unknown>>;
    delete a.water.safe;
    a.classrooms.total = -1;
    a.power.source = 'NUCLEAR';
    (a as Record<string, unknown>).extra = {};
    const { problems } = checkAnswers(a);
    expect(problems).toEqual(expect.arrayContaining([
      'Unknown section "extra".', 'Classrooms: Number of classrooms must be a whole number from 0 to 1000.',
      'Water: Safe to drink is not answered.', 'Power: Main power source must be one of: None, Grid, Solar, Generator.',
    ]));
    const b = goodAnswers();
    b.classrooms.usable = 13;
    expect(checkAnswers(b).problems).toEqual(['Classrooms: more safe classrooms than classrooms.']);
  });

  it('grades a school from its answers', () => {
    expect(assess(checkAnswers(goodAnswers()).answers)).toEqual({ overall: 'GOOD', issues: [] });
    const fair = goodAnswers();
    fair.safety.firstAid = false;
    expect(assess(fair).overall).toBe('FAIR');
    const poor = goodAnswers();
    poor.classrooms.roofLeaks = true;
    poor.water.working = false;
    expect(assess(poor)).toMatchObject({ overall: 'POOR', issues: [{ text: 'Roof leaks' }, { text: 'No water on the day' }] });
    const critical = goodAnswers();
    critical.toilets.working = 0;
    critical.safety.hazards = true;
    expect(assess(critical).issues.slice(0, 2).map((i) => i.level)).toEqual(['CRITICAL', 'CRITICAL']);
  });
});

/** Inspections and photos end to end. Erases the test database first. */
describe('Inspections (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    get: (url: string) => http().get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => http().post(url).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    upload: (url: string, file: Buffer, fields: Record<string, string>) => {
      const r = http().post(url).set('Authorization', `Bearer ${token}`);
      Object.entries(fields).forEach(([k, v]) => r.field(k, v));
      return r.attach('photo', file, { filename: 'p.jpg', contentType: 'image/jpeg' });
    },
  });
  async function activate(identifier: string, temp: string) {
    const first = await http().post('/auth/login').send({ identifier, password: temp }).expect(200);
    const r = await http().post('/auth/change-password').set('Authorization', `Bearer ${first.body.accessToken}`).send({ currentPassword: temp, newPassword: 'Permanent2026' }).expect(200);
    return r.body.accessToken as string;
  }
  const today = new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);

  let ministry: ReturnType<typeof as>;
  let inspector: ReturnType<typeof as>;
  let stateInspector: ReturnType<typeof as>;
  let schoolA: ReturnType<typeof as>;
  let schoolB: ReturnType<typeof as>;
  let aId: string;
  let bId: string;
  let inspectionId: string;

  beforeAll(async () => {
    process.env.COOKIE_SECURE = 'false';
    process.env.LOGIN_RATE_LIMIT = '1000';
    process.env.JWT_ACCESS_SECRET ??= 'test-secret-test-secret-test-secret-123';
    prisma = new PrismaClient();
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Notice", "Notification", "DeviceToken", "SmsMessage", "Holiday", "SyncEvent", "Score", "ScoreSheet", "ClassSubject", "ClassResult", "ReportRemark", "Term", "AttendanceMark", "AttendanceRegister", "AuditLog", "RefreshToken", "Transfer", "StudentGuardian", "ClassPlacement", "Enrolment", "Student", "ClassArm", "AcademicSession", "Counter", "User", "School" CASCADE',
    );
    await prisma.user.create({ data: { fullName: 'Ministry Admin', email: 'admin@moe.test', role: Role.MINISTRY_ADMIN, passwordHash: await hashPassword('Temp1234x') } });
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    setupApp(app);
    await app.init();
    ministry = as(await activate('admin@moe.test', 'Temp1234x'));
    const a = await ministry.post('/schools', { name: 'Osogbo Grammar School', lga: 'Osogbo', level: 'JUNIOR_AND_SENIOR', ownership: 'PUBLIC', admin: { fullName: 'Head A', email: 'a@x.test' } }).expect(201);
    aId = a.body.school.id;
    schoolA = as(await activate('a@x.test', a.body.admin.tempPassword));
    const b = await ministry.post('/schools', { name: 'Iwo High School', lga: 'Iwo', level: 'JUNIOR_AND_SENIOR', ownership: 'PUBLIC', admin: { fullName: 'Head B', email: 'b@x.test' } }).expect(201);
    bId = b.body.school.id;
    schoolB = as(await activate('b@x.test', b.body.admin.tempPassword));
    const i = await ministry.post('/users', { fullName: 'Osogbo Inspector', email: 'i@x.test', role: 'INSPECTOR', lga: 'Osogbo' }).expect(201);
    inspector = as(await activate('i@x.test', i.body.tempPassword));
    const s = await ministry.post('/users', { fullName: 'State Inspector', email: 's@x.test', role: 'INSPECTOR' }).expect(201);
    stateInspector = as(await activate('s@x.test', s.body.tempPassword));
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('records a visit once, even when the phone sends it twice', async () => {
    expect((await inspector.get('/inspections/template').expect(200)).body.sections.map((s: { key: string }) => s.key)).toEqual(['classrooms', 'toilets', 'water', 'power', 'safety', 'facilities']);
    const answers = goodAnswers();
    answers.classrooms.roofLeaks = true;
    const body = { clientId: 'phone-0001-abcdef', schoolId: aId, visitedOn: today, answers, notes: 'Roof over JSS 2 leaks.' };
    await schoolA.post('/inspections', body).expect(403);
    await inspector.post('/inspections', { ...body, schoolId: bId }).expect(404);
    const bad = await inspector.post('/inspections', { ...body, answers: { ...answers, water: {} } }).expect(400);
    expect(bad.body.problems).toHaveLength(3);
    const first = await inspector.post('/inspections', body).expect(201);
    expect(first.body).toMatchObject({ overall: 'POOR', duplicate: false, school: { name: 'Osogbo Grammar School' }, issues: [{ text: 'Roof leaks' }] });
    inspectionId = first.body.id;
    const again = await inspector.post('/inspections', body).expect(201);
    expect(again.body).toMatchObject({ id: inspectionId, duplicate: true });
    await stateInspector.post('/inspections', body).expect(409);
    await inspector.post('/inspections', { ...body, clientId: 'phone-0002-abcdef', visitedOn: '2099-01-01' }).expect(400);
  });

  it('stores photos once, checks they are images, and serves them to people who can see the school', async () => {
    const up = (clientId: string, file = jpeg, section = 'classrooms') => inspector.upload(`/inspections/${inspectionId}/photos`, file, { clientId, section, caption: 'Leaking roof' });
    await up('photo-not-image', Buffer.from('not an image at all')).expect(400);
    await up('photo-bad-section', jpeg, 'kitchen').expect(400);
    await stateInspector.upload(`/inspections/${inspectionId}/photos`, jpeg, { clientId: 'photo-other-one', section: 'classrooms' }).expect(403);
    const p = await up('photo-0001-abcdef').expect(201);
    expect(p.body).toMatchObject({ section: 'classrooms', caption: 'Leaking roof', bytes: jpeg.length, duplicate: false });
    expect((await up('photo-0001-abcdef').expect(201)).body).toMatchObject({ id: p.body.id, duplicate: true });
    await up('photo-too-big', Buffer.concat([jpeg, Buffer.alloc(5 * 1024 * 1024)])).expect(413);

    const img = await schoolA.get(`/inspections/photos/${p.body.id}`).expect(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect(Buffer.compare(img.body, jpeg)).toBe(0);
    await schoolB.get(`/inspections/photos/${p.body.id}`).expect(404);
    const full = await stateInspector.get(`/inspections/${inspectionId}`).expect(200);
    expect(full.body).toMatchObject({ photoCount: 1, notes: 'Roof over JSS 2 leaks.', answers: { classrooms: { roofLeaks: true } } });
  });

  it('lists inspections for the school, the LGA and the Ministry only', async () => {
    expect((await schoolA.get('/inspections').expect(200)).body).toHaveLength(1);
    expect((await schoolB.get('/inspections').expect(200)).body).toHaveLength(0);
    await schoolB.get(`/inspections/${inspectionId}`).expect(404);
    expect((await ministry.get('/inspections?overall=POOR').expect(200)).body).toHaveLength(1);
    expect((await ministry.get('/inspections?overall=GOOD').expect(200)).body).toHaveLength(0);
    expect((await inspector.get('/inspections?mine=true').expect(200)).body).toHaveLength(1);
    expect((await stateInspector.get('/inspections?mine=true').expect(200)).body).toHaveLength(0);
  });
});
