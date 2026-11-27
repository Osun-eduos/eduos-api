import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, Role } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/common/password';
import { setupApp } from '../src/setup-app';

/** LGA education officers and inspectors: read-only, limited to one LGA (or state-wide inspectors). Erases the test database first. */
describe('LGA officers and inspectors (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    get: (url: string) => http().get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => http().post(url).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    put: (url: string, body: object) => http().put(url).set('Authorization', `Bearer ${token}`).send(body),
    patch: (url: string, body: object) => http().patch(url).set('Authorization', `Bearer ${token}`).send(body),
  });
  async function activate(identifier: string, temp: string) {
    const first = await http().post('/auth/login').send({ identifier, password: temp }).expect(200);
    const r = await http().post('/auth/change-password').set('Authorization', `Bearer ${first.body.accessToken}`).send({ currentPassword: temp, newPassword: 'steady-maple-road-26' }).expect(200);
    return r.body.accessToken as string;
  }
  const DAY = 86_400_000;
  const now = new Date(new Date(Date.now() + 3_600_000).toISOString().slice(0, 10) + 'T00:00:00Z');
  const iso = (o: number) => new Date(now.getTime() + o * DAY).toISOString().slice(0, 10);

  let ministry: ReturnType<typeof as>;
  let osogboSchool: ReturnType<typeof as>;
  let officer: ReturnType<typeof as>;
  let officerId: string;
  let inspector: ReturnType<typeof as>;
  let iwoInspector: ReturnType<typeof as>;
  let schoolA: string; // Osogbo
  let schoolB: string; // Iwo
  let ada: string;
  let bisi: string;

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
    ministry = as(await activate('admin@moe.test', 'Temp1234x'));
    await ministry.post('/sessions', { name: '2050/2051', startDate: iso(-60), endDate: iso(200) }).expect(201);
    await ministry.post('/terms', { number: 1, startDate: iso(-50), endDate: iso(30) }).expect(201);

    const a = await ministry.post('/schools', { name: 'Osogbo Grammar School', lga: 'Osogbo', level: 'JUNIOR_AND_SENIOR', ownership: 'PUBLIC', admin: { fullName: 'Head A', email: 'a@x.test' } }).expect(201);
    schoolA = a.body.school.id;
    osogboSchool = as(await activate('a@x.test', a.body.admin.tempPassword));
    const b = await ministry.post('/schools', { name: 'Iwo Community High School', lga: 'Iwo', level: 'JUNIOR_AND_SENIOR', ownership: 'PUBLIC', admin: { fullName: 'Head B', email: 'b@x.test' } }).expect(201);
    schoolB = b.body.school.id;
    const iwoSchool = as(await activate('b@x.test', b.body.admin.tempPassword));
    const cls = (await osogboSchool.post('/classes', { level: 'JSS_1', arm: 'A' }).expect(201)).body.id;
    ada = (await osogboSchool.post('/students', { surname: 'Adeyemi', firstName: 'Ada', sex: 'F', dateOfBirth: '2014-01-01', classArmId: cls, admittedOn: iso(-40) }).expect(201)).body.student.id;
    bisi = (await iwoSchool.post('/students', { surname: 'Adeyemi', firstName: 'Bisi', sex: 'F', dateOfBirth: '2014-02-02', admittedOn: iso(-40) }).expect(201)).body.student.id;
    await osogboSchool.post('/transfers', { studentId: ada, toSchoolId: schoolB, reason: 'Family moved to Iwo' }).expect(201);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('lets only the Ministry administrator create LGA officers and inspectors, with a valid LGA', async () => {
    await ministry.post('/users', { fullName: 'No Area', email: 'x@x.test', role: 'LGA_OFFICER' }).expect(400);
    const bad = await ministry.post('/users', { fullName: 'Wrong Area', email: 'y@x.test', role: 'LGA_OFFICER', lga: 'Ikeja' }).expect(400);
    expect(bad.body.message).toMatch(/not an Osun LGA/);
    await ministry.post('/users', { fullName: 'Teacher With Area', email: 'z@x.test', role: 'TEACHER', schoolId: schoolA, lga: 'Osogbo' }).expect(400);
    await osogboSchool.post('/users', { fullName: 'Sneaky', email: 's@x.test', role: 'LGA_OFFICER', lga: 'Osogbo' }).expect(403);

    const o = await ministry.post('/users', { fullName: 'Kola Officer', email: 'kola@x.test', role: 'LGA_OFFICER', lga: 'osogbo' }).expect(201);
    expect(o.body.user).toMatchObject({ role: 'LGA_OFFICER', lga: 'Osogbo', schoolId: null });
    officerId = o.body.user.id;
    officer = as(await activate('kola@x.test', o.body.tempPassword));
    const i = await ministry.post('/users', { fullName: 'State Inspector', email: 'insp@x.test', role: 'INSPECTOR' }).expect(201);
    expect(i.body.user.lga).toBeNull();
    inspector = as(await activate('insp@x.test', i.body.tempPassword));
    const j = await ministry.post('/users', { fullName: 'Iwo Inspector', email: 'iwo@x.test', role: 'INSPECTOR', lga: 'Iwo' }).expect(201);
    iwoInspector = as(await activate('iwo@x.test', j.body.tempPassword));
  });

  it('shows an LGA officer only the schools and students in their LGA', async () => {
    const schools = await officer.get('/schools').expect(200);
    expect(schools.body.map((s: { name: string }) => s.name)).toEqual(['Osogbo Grammar School']);
    await officer.get(`/schools/${schoolA}`).expect(200);
    await officer.get(`/schools/${schoolB}`).expect(404);
    expect((await officer.get('/schools/directory').expect(200)).body.map((s: { lga: string }) => s.lga)).toEqual(['Osogbo']);
    // Schools still see every school as a transfer destination.
    expect((await osogboSchool.get('/schools/directory').expect(200)).body).toHaveLength(2);

    const found = await officer.get('/students?q=Adeyemi').expect(200);
    expect(found.body.map((s: { firstName: string }) => s.firstName)).toEqual(['Ada']);
    await officer.get(`/students/${ada}`).expect(200);
    await officer.get(`/students/${bisi}`).expect(404);
    await officer.get(`/classes?schoolId=${schoolB}`).expect(404);
    expect((await officer.get(`/classes?schoolId=${schoolA}`).expect(200)).body).toHaveLength(1);
  });

  it('scopes attendance, transfers, results and home counts to the LGA', async () => {
    await officer.get(`/attendance/day?schoolId=${schoolA}`).expect(200);
    await officer.get(`/attendance/day?schoolId=${schoolB}`).expect(404);
    expect((await officer.get('/transfers').expect(200)).body).toHaveLength(1);
    expect((await officer.get('/results/summary').expect(200)).body.schools).toEqual([]);
    const stats = await officer.get('/stats').expect(200);
    expect(stats.body).toMatchObject({ lga: 'Osogbo', schools: 1, students: 1 });
    const iwo = await iwoInspector.get('/stats').expect(200);
    expect(iwo.body).toMatchObject({ lga: 'Iwo', schools: 1, students: 1 });
  });

  it('gives a state-wide inspector the whole state, read-only', async () => {
    expect((await inspector.get('/schools').expect(200)).body).toHaveLength(2);
    expect((await inspector.get('/students?q=Adeyemi').expect(200)).body).toHaveLength(2);
    expect((await inspector.get('/stats').expect(200)).body).toMatchObject({ lga: null, schools: 2, students: 2 });
  });

  it('keeps oversight roles read-only', async () => {
    await officer.post('/schools', { name: 'New School', lga: 'Osogbo', level: 'PRIMARY', ownership: 'PUBLIC' }).expect(403);
    await officer.get('/users').expect(403);
    await officer.get('/audit').expect(403);
    await inspector.post('/sessions', { name: '2051/2052', startDate: '2051-09-01', endDate: '2052-07-01' }).expect(403);
    const classes = (await officer.get(`/classes?schoolId=${schoolA}`).expect(200)).body;
    await officer.put('/attendance/register', { classId: classes[0].id, date: iso(0), marks: [] }).expect(403);
    await inspector.post('/students', { surname: 'X', firstName: 'Y', sex: 'M', dateOfBirth: '2014-01-01' }).expect(403);
  });

  it('applies an LGA change at once by signing the officer out', async () => {
    const login = await http().post('/auth/login').send({ identifier: 'kola@x.test', password: 'steady-maple-road-26' }).expect(200);
    const cookie = login.headers['set-cookie'];
    await ministry.patch(`/users/${officerId}`, { lga: 'Iwo' }).expect(200);
    await http().post('/auth/refresh').set('Cookie', cookie).expect(401);
    const again = await http().post('/auth/login').send({ identifier: 'kola@x.test', password: 'steady-maple-road-26' }).expect(200);
    const moved = as(again.body.accessToken);
    expect((await moved.get('/schools').expect(200)).body.map((s: { lga: string }) => s.lga)).toEqual(['Iwo']);
    await ministry.patch(`/users/${officerId}`, { lga: '' }).expect(400);
  });
});
