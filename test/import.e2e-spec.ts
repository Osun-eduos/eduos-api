import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, Role } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/common/password';
import { setupApp } from '../src/setup-app';
import { classKey, readDate } from '../src/students/import';

/** Enrolling students from a spreadsheet. Erases the test database first. */
describe('Student import (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    get: (url: string) => http().get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => http().post(url).set('Authorization', `Bearer ${token}`).send(body ?? {}),
  });
  async function activate(identifier: string, temp: string) {
    const first = await http().post('/auth/login').send({ identifier, password: temp }).expect(200);
    const r = await http().post('/auth/change-password').set('Authorization', `Bearer ${first.body.accessToken}`).send({ currentPassword: temp, newPassword: 'Permanent2026' }).expect(200);
    return r.body.accessToken as string;
  }
  const DAY = 86_400_000;
  const now = new Date(new Date(Date.now() + 3_600_000).toISOString().slice(0, 10) + 'T00:00:00Z');
  const iso = (o: number) => new Date(now.getTime() + o * DAY).toISOString().slice(0, 10);

  let ministry: ReturnType<typeof as>;
  let school: ReturnType<typeof as>;
  let other: ReturnType<typeof as>;
  let teacher: ReturnType<typeof as>;

  beforeAll(async () => {
    process.env.COOKIE_SECURE = 'false';
    process.env.LOGIN_RATE_LIMIT = '1000';
    process.env.JWT_ACCESS_SECRET ??= 'test-secret-test-secret-test-secret-123';
    prisma = new PrismaClient();
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Holiday", "SyncEvent", "Score", "ScoreSheet", "ClassSubject", "ClassResult", "ReportRemark", "Term", "AttendanceMark", "AttendanceRegister", "AuditLog", "RefreshToken", "Transfer", "StudentGuardian", "ClassPlacement", "Enrolment", "Student", "ClassArm", "AcademicSession", "Counter", "User", "School" CASCADE',
    );
    await prisma.user.create({ data: { fullName: 'Ministry Admin', email: 'admin@moe.test', role: Role.MINISTRY_ADMIN, passwordHash: await hashPassword('Temp1234x') } });
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    setupApp(app);
    await app.init();
    ministry = as(await activate('admin@moe.test', 'Temp1234x'));
    await ministry.post('/sessions', { name: '2060/2061', startDate: iso(-60), endDate: iso(200) }).expect(201);
    const a = await ministry.post('/schools', { name: 'Ikirun High School', lga: 'Ifelodun', level: 'JUNIOR_AND_SENIOR', ownership: 'PUBLIC', admin: { fullName: 'Head A', email: 'a@x.test' } }).expect(201);
    school = as(await activate('a@x.test', a.body.admin.tempPassword));
    const b = await ministry.post('/schools', { name: 'Ila Grammar School', lga: 'Ila', level: 'JUNIOR_AND_SENIOR', ownership: 'PUBLIC', admin: { fullName: 'Head B', email: 'b@x.test' } }).expect(201);
    other = as(await activate('b@x.test', b.body.admin.tempPassword));
    await school.post('/classes', { level: 'JSS_1', arm: 'A' }).expect(201);
    await school.post('/classes', { level: 'JSS_2', arm: 'B', capacity: 1 }).expect(201);
    const t = await school.post('/users', { fullName: 'Teacher T', email: 't@x.test', role: 'TEACHER' }).expect(201);
    teacher = as(await activate('t@x.test', t.body.tempPassword));
    // An existing parent at the school, and a student elsewhere with a clashing name.
    await school.post('/users', { fullName: 'Existing Parent', phone: '08030000001', role: 'PARENT' }).expect(201);
    await other.post('/students', { surname: 'Ojo', firstName: 'Femi', sex: 'M', dateOfBirth: '2014-05-05' }).expect(201);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const rows = [
    { surname: 'Adewale', firstName: 'Tolu', sex: 'Female', dateOfBirth: '03/02/2014', className: 'jss1a', parentName: 'Mrs Adewale', parentPhone: '0803 111 2222', relationship: 'mother' },
    { surname: 'Adewale', firstName: 'Kunle', sex: 'm', dateOfBirth: '2013-07-09', className: 'JSS 1A', parentName: 'Mrs Adewale', parentPhone: '+2348031112222', relationship: 'Mother' },
    { surname: 'Bakare', firstName: 'Ife', sex: 'F', dateOfBirth: '12/12/2013', className: 'JSS 2B', parentPhone: '08030000001', relationship: 'Father', admittedOn: '14/09/2025' },
    { surname: 'Bakare', firstName: 'Seyi', sex: 'F', dateOfBirth: '12/12/2013', className: 'JSS 2B' },
    { surname: 'Ojo', firstName: 'Femi', sex: 'M', dateOfBirth: '05/05/2014' },
    { surname: 'X', firstName: 'Bad', sex: 'Q', dateOfBirth: '31/02/2014', className: 'SSS 9Z', parentPhone: '123', relationship: 'Cousin' },
    { surname: 'Adewale', firstName: 'Tolu', sex: 'F', dateOfBirth: '2014-02-03' },
    { surname: 'Lone', firstName: 'Child', sex: 'M', dateOfBirth: '2015-01-01', parentName: 'Mr Lone' },
  ];

  it('reads day-first dates and loose class names', () => {
    expect(readDate('03/02/2014')?.toISOString().slice(0, 10)).toBe('2014-02-03');
    expect(readDate('3-2-2014')?.toISOString().slice(0, 10)).toBe('2014-02-03');
    expect(readDate('2014-2-3')?.toISOString().slice(0, 10)).toBe('2014-02-03');
    expect(readDate('31/02/2014')).toBeNull();
    expect(readDate('Feb 3 2014')).toBeNull();
    expect(classKey('JSS 2A')).toBe(classKey('jss-2-a'));
  });

  it('only lets school administrators import, and limits the size', async () => {
    await teacher.post('/students/import', { rows, dryRun: true }).expect(403);
    await ministry.post('/students/import', { rows, dryRun: true }).expect(403);
    await school.post('/students/import', { rows: [], dryRun: true }).expect(400);
    const big = Array.from({ length: 501 }, (_, i) => ({ surname: 'Many', firstName: `Kid${i}`, sex: 'F', dateOfBirth: '2014-01-01' }));
    const r = await school.post('/students/import', { rows: big, dryRun: true }).expect(400);
    expect(JSON.stringify(r.body.message)).toMatch(/at most 500/);
    await school.post('/students/import', { rows: [{ surname: 'A', unknownColumn: 'x' }], dryRun: true }).expect(400);
  });

  it('checks every row without saving on a dry run', async () => {
    const r = await school.post('/students/import', { rows, dryRun: true }).expect(200);
    expect(r.body).toMatchObject({ dryRun: true, total: 8, ready: 3, withProblems: 5, imported: 0 });
    const byRow = Object.fromEntries(r.body.rows.map((x: { row: number }) => [x.row, x]));
    expect(byRow[2]).toMatchObject({ ok: true, student: { fullName: 'Adewale Tolu', sex: 'F', dateOfBirth: '2014-02-03', className: 'JSS 1A' }, parent: { account: 'new', relationship: 'Mother' } });
    expect(byRow[3].ok).toBe(true);
    expect(byRow[3].warnings.join()).toMatch(/same new parent as row 2/);
    expect(byRow[4]).toMatchObject({ ok: true, parent: { account: 'existing', fullName: 'Existing Parent' } });
    expect(byRow[5].errors.join()).toMatch(/JSS 2B is full/);
    expect(byRow[6].errors.join()).toMatch(/enrolled at Ila Grammar School/);
    const bad = byRow[7].errors.join(' | ');
    for (const m of [/Surname is missing/, /Sex "Q"/, /not a date/, /no class called "SSS 9Z"/, /not a valid Nigerian number/, /Relationship "Cousin"/]) expect(bad).toMatch(m);
    expect(byRow[8].errors.join()).toMatch(/Same name and date of birth as row 2/);
    expect(byRow[9].errors.join()).toMatch(/phone number or email/);
    expect(await prisma.student.count()).toBe(1);
  });

  it('imports the rows that are ready, links parents once, and returns new parent sign-ins', async () => {
    const r = await school.post('/students/import', { rows }).expect(200);
    expect(r.body).toMatchObject({ dryRun: false, imported: 3, withProblems: 5 });
    expect(r.body.parents).toHaveLength(1);
    expect(r.body.parents[0]).toMatchObject({ fullName: 'Mrs Adewale', phone: '+2348031112222', children: ['Adewale Tolu', 'Adewale Kunle'] });
    expect(r.body.parents[0].tempPassword).toEqual(expect.any(String));

    const list = (await school.get('/students?q=Adewale').expect(200)).body;
    expect(list).toHaveLength(2);
    expect(list.every((s: { currentClass: { name: string } | null }) => s.currentClass?.name === 'JSS 1A')).toBe(true);
    const ife = (await school.get('/students?q=Bakare').expect(200)).body[0];
    const record = (await school.get(`/students/${ife.id}`).expect(200)).body;
    expect(record.guardians[0]).toMatchObject({ relationship: 'Father', fullName: 'Existing Parent' });
    expect(record.enrolments[0].admittedOn).toBe('2025-09-14');

    const parent = await http().post('/auth/login').send({ identifier: '08031112222', password: r.body.parents[0].tempPassword }).expect(200);
    expect(parent.body.user.role).toBe('PARENT');

    const again = await school.post('/students/import', { rows: rows.slice(0, 2) }).expect(200);
    expect(again.body.imported).toBe(0);
    expect(again.body.rows[0].errors.join()).toMatch(/Already enrolled at your school/);
  });
});
