import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, Role } from '@prisma/client';
import request from 'supertest';
import { completeTwoStep } from './helpers/two-step';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/common/password';
import { setupApp } from '../src/setup-app';

/** Daily registers, edit rules, school-day overview and attendance summaries. Erases the test database first. */
describe('Attendance (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    get: (url: string) => http().get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => http().post(url).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    put: (url: string, body: object) => http().put(url).set('Authorization', `Bearer ${token}`).send(body),
    patch: (url: string, body: object) => http().patch(url).set('Authorization', `Bearer ${token}`).send(body),
    del: (url: string) => http().delete(url).set('Authorization', `Bearer ${token}`),
  });

  async function activate(identifier: string, temp: string) {
    const first = await http().post('/auth/login').send({ identifier, password: temp }).expect(200);
    const r = await http()
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${first.body.accessToken}`)
      .send({ currentPassword: temp, newPassword: 'steady-maple-road-26' })
      .expect(200);
    return completeTwoStep(http, r);
  }

  // Dates relative to today in Nigeria, so the tests pass whenever they run.
  const DAY = 86_400_000;
  const lagosToday = () => new Date(new Date(Date.now() + 3_600_000).toISOString().slice(0, 10) + 'T00:00:00Z');
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const isWeekday = (d: Date) => d.getUTCDay() !== 0 && d.getUTCDay() !== 6;
  /** The nth most recent weekday on or before today (0 = latest). */
  function weekday(n: number, before = lagosToday()) {
    let d = before;
    let seen = -1;
    for (;;) {
      if (isWeekday(d) && ++seen === n) return iso(d);
      d = new Date(d.getTime() - DAY);
    }
  }
  function weekend() {
    let d = lagosToday();
    while (isWeekday(d)) d = new Date(d.getTime() - DAY);
    return iso(d);
  }

  let ministry: ReturnType<typeof as>;
  let schoolA: ReturnType<typeof as>;
  let schoolB: ReturnType<typeof as>;
  let teacher: ReturnType<typeof as>;
  let otherTeacher: ReturnType<typeof as>;
  let parent: ReturnType<typeof as>;
  let schoolAId: string;
  let schoolBId: string;
  let cls: string;
  let emptyCls: string;
  let kemi: string;
  let tobi: string;
  let sade: string;
  const recent = weekday(1);
  const old = weekday(8);

  beforeAll(async () => {
    process.env.COOKIE_SECURE = 'false';
    process.env.LOGIN_RATE_LIMIT = '1000';
    prisma = new PrismaClient();
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Notice", "Notification", "DeviceToken", "SmsMessage", "Holiday", "AttendanceMark", "AttendanceRegister", "AuditLog", "RefreshToken", "Transfer", "StudentGuardian", "ClassPlacement", "Enrolment", "Student", "ClassArm", "AcademicSession", "Counter", "User", "School" CASCADE',
    );
    await prisma.user.create({
      data: { fullName: 'Ministry Admin', email: 'admin@moe.test', role: Role.MINISTRY_ADMIN, passwordHash: await hashPassword('Temp1234x') },
    });
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    setupApp(app);
    await app.init();
    ministry = as(await activate('admin@moe.test', 'Temp1234x'));

    const now = lagosToday();
    await ministry
      .post('/sessions', { name: '2030/2031', startDate: iso(new Date(now.getTime() - 60 * DAY)), endDate: iso(new Date(now.getTime() + 200 * DAY)) })
      .expect(201);

    const a = await ministry
      .post('/schools', { name: 'Ilesa Grammar School', lga: 'Ilesa East', level: 'JUNIOR_AND_SENIOR', ownership: 'PUBLIC', admin: { fullName: 'Principal A', email: 'a@school.test' } })
      .expect(201);
    schoolAId = a.body.school.id;
    schoolA = as(await activate('a@school.test', a.body.admin.tempPassword));
    const b = await ministry
      .post('/schools', { name: 'Ede Muslim High School', lga: 'Ede North', level: 'JUNIOR_AND_SENIOR', ownership: 'PUBLIC', admin: { fullName: 'Principal B', email: 'b@school.test' } })
      .expect(201);
    schoolBId = b.body.school.id;
    schoolB = as(await activate('b@school.test', b.body.admin.tempPassword));

    const t = await schoolA.post('/users', { fullName: 'Grace Akinola', email: 'grace@school.test', role: 'TEACHER' }).expect(201);
    teacher = as(await activate('grace@school.test', t.body.tempPassword));
    const t2 = await schoolA.post('/users', { fullName: 'Segun Ojo', email: 'segun@school.test', role: 'TEACHER' }).expect(201);
    otherTeacher = as(await activate('segun@school.test', t2.body.tempPassword));

    cls = (await schoolA.post('/classes', { level: 'JSS_1', arm: 'A', classTeacherId: t.body.user.id }).expect(201)).body.id;
    emptyCls = (await schoolA.post('/classes', { level: 'JSS_1', arm: 'B', classTeacherId: t2.body.user.id }).expect(201)).body.id;

    const k = await schoolA
      .post('/students', {
        surname: 'Bello', firstName: 'Kemi', sex: 'F', dateOfBirth: '2014-03-09', classArmId: cls, admittedOn: iso(new Date(now.getTime() - 30 * DAY)),
        guardian: { relationship: 'Father', newParent: { fullName: 'Musa Bello', phone: '08051112233' } },
      })
      .expect(201);
    kemi = k.body.student.id;
    parent = as(await activate('08051112233', k.body.parent.tempPassword));
    const admittedOn = iso(new Date(now.getTime() - 30 * DAY));
    tobi = (await schoolA.post('/students', { surname: 'Adio', firstName: 'Tobi', sex: 'M', dateOfBirth: '2014-07-21', classArmId: cls, admittedOn }).expect(201)).body.student.id;
    sade = (await schoolA.post('/students', { surname: 'Ola', firstName: 'Sade', sex: 'F', dateOfBirth: '2014-01-30', classArmId: cls, admittedOn }).expect(201)).body.student.id;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const allPresent = (date: string, extra: Record<string, string> = {}) => ({
    classId: cls,
    date,
    marks: [kemi, tobi, sade].map((id) => ({ studentId: id, status: extra[id] ?? 'PRESENT' })),
  });

  it('shows an empty register with every student in the class', async () => {
    const r = await teacher.get(`/attendance/register?classId=${cls}&date=${recent}`).expect(200);
    expect(r.body.class.name).toBe('JSS 1A');
    expect(r.body.editable).toBe(true);
    expect(r.body.register).toBeNull();
    expect(r.body.students.map((s: { fullName: string }) => s.fullName)).toEqual(['Adio Tobi', 'Bello Kemi', 'Ola Sade']);
    expect(r.body.students.every((s: { status: null }) => s.status === null)).toBe(true);
  });

  it('lets the class teacher take the register, and only them or the school', async () => {
    const body = allPresent(recent, { [tobi]: 'ABSENT', [sade]: 'LATE' });
    await otherTeacher.put('/attendance/register', body).expect(404);
    await schoolB.put('/attendance/register', body).expect(404);
    await ministry.put('/attendance/register', body).expect(403);
    await parent.put('/attendance/register', body).expect(403);
    const r = await teacher.put('/attendance/register', body).expect(200);
    expect(r.body.register.takenBy).toBe('Grace Akinola');
    expect(r.body.totals).toEqual({ PRESENT: 1, LATE: 1, ABSENT: 1, EXCUSED: 0 });
  });

  it('requires every student to be marked, once, and only students in the class', async () => {
    const d = weekday(0);
    const missing = await teacher.put('/attendance/register', { classId: cls, date: d, marks: [{ studentId: kemi, status: 'PRESENT' }] }).expect(400);
    expect(missing.body.message).toMatch(/2 students are not marked/);
    const dup = allPresent(d);
    dup.marks.push({ studentId: kemi, status: 'ABSENT' });
    await teacher.put('/attendance/register', dup).expect(400);
    const outsider = (await schoolB.post('/students', { surname: 'Yusuf', firstName: 'Ade', sex: 'M', dateOfBirth: '2014-05-05' }).expect(201)).body.student.id;
    const extra = allPresent(d);
    extra.marks.push({ studentId: outsider, status: 'PRESENT' });
    await teacher.put('/attendance/register', extra).expect(400);
    await teacher.put('/attendance/register', { ...allPresent(d), marks: [{ studentId: kemi, status: 'ASLEEP' }] }).expect(400);
    await otherTeacher.put('/attendance/register', { classId: emptyCls, date: d, marks: [] }).expect(400);
  });

  it('rejects future dates, weekends and dates outside the session', async () => {
    const tomorrow = iso(new Date(lagosToday().getTime() + DAY));
    await teacher.put('/attendance/register', allPresent(tomorrow)).expect(400);
    const w = await teacher.get(`/attendance/register?classId=${cls}&date=${weekend()}`).expect(400);
    expect(w.body.message).toMatch(/weekend/);
    const before = weekday(0, new Date(lagosToday().getTime() - 90 * DAY));
    const out = await teacher.put('/attendance/register', allPresent(before)).expect(400);
    expect(out.body.message).toMatch(/outside the 2030\/2031 session/);
  });

  it('lets a correction replace marks and records who changed it', async () => {
    const r = await teacher.put('/attendance/register', allPresent(recent, { [tobi]: 'EXCUSED' })).expect(200);
    expect(r.body.totals).toEqual({ PRESENT: 2, LATE: 0, ABSENT: 0, EXCUSED: 1 });
    expect(r.body.register.updatedBy).toBe('Grace Akinola');
    const log = await schoolA.get('/audit').expect(200);
    const actions = (log.body.items ?? log.body).map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['attendance.taken', 'attendance.updated']));
  });

  it('locks old registers for teachers but not for the school administrator', async () => {
    const view = await teacher.get(`/attendance/register?classId=${cls}&date=${old}`).expect(200);
    expect(view.body.editable).toBe(false);
    expect(view.body.lockedReason).toMatch(/last 7 days/);
    await teacher.put('/attendance/register', allPresent(old)).expect(403);
    const r = await schoolA.put('/attendance/register', allPresent(old, { [kemi]: 'ABSENT' })).expect(200);
    expect(r.body.register.takenBy).toBe('Principal A');
  });

  it('shows the school which classes have taken the register on a day', async () => {
    const r = await schoolA.get(`/attendance/day?date=${recent}`).expect(200);
    expect(r.body.isSchoolDay).toBe(true);
    const a = r.body.classes.find((c: { name: string }) => c.name === 'JSS 1A');
    const b = r.body.classes.find((c: { name: string }) => c.name === 'JSS 1B');
    expect(a).toMatchObject({ taken: true, takenBy: 'Grace Akinola', students: 3, counts: { PRESENT: 2, EXCUSED: 1 } });
    expect(b).toMatchObject({ taken: false, students: 0, counts: null });
    expect(r.body.totals).toMatchObject({ classes: 1, taken: 1, PRESENT: 2, EXCUSED: 1 });
    await ministry.get(`/attendance/day?date=${recent}`).expect(400);
    const m = await ministry.get(`/attendance/day?date=${recent}&schoolId=${schoolAId}`).expect(200);
    expect(m.body.totals.taken).toBe(1);
    const other = await schoolB.get(`/attendance/day?date=${recent}`).expect(200);
    expect(other.body.totals.taken).toBe(0);
    await teacher.get(`/attendance/day`).expect(403);
  });

  it('summarises a class over the session so far', async () => {
    const r = await teacher.get(`/attendance/class?classId=${cls}`).expect(200);
    expect(r.body.registers).toBe(2);
    const k = r.body.students.find((s: { id: string }) => s.id === kemi);
    expect(k.counts).toEqual({ PRESENT: 1, LATE: 0, ABSENT: 1, EXCUSED: 0 });
    expect(k.rate).toBe(50);
    expect(r.body.days.map((d: { date: string }) => d.date)).toEqual([old, recent]);
    await otherTeacher.get(`/attendance/class?classId=${cls}`).expect(404);
  });

  it("shows a parent only their own child's attendance", async () => {
    const r = await parent.get(`/attendance/students/${kemi}`).expect(200);
    expect(r.body.counts).toEqual({ PRESENT: 1, LATE: 0, ABSENT: 1, EXCUSED: 0 });
    expect(r.body.rate).toBe(50);
    expect(r.body.records[0]).toMatchObject({ date: recent, status: 'PRESENT', className: 'JSS 1A', school: 'Ilesa Grammar School' });
    await parent.get(`/attendance/students/${tobi}`).expect(404);
    await schoolB.get(`/attendance/students/${kemi}`).expect(404);
  });

  it('keeps marks with the student after they move class, and reports progress on the home screen', async () => {
    await schoolA.post(`/students/${sade}/placement`, { classArmId: emptyCls }).expect(201);
    const reg = await teacher.get(`/attendance/register?classId=${cls}&date=${recent}`).expect(200);
    const s = reg.body.students.find((x: { id: string }) => x.id === sade);
    expect(s).toMatchObject({ status: 'PRESENT', inClass: false });
    const hist = await schoolA.get(`/attendance/students/${sade}`).expect(200);
    expect(hist.body.records).toHaveLength(2);
    await schoolA.del(`/classes/${cls}`).expect(400);

    // A student admitted today is not on the roll for earlier days.
    const late = (await schoolA.post('/students', { surname: 'Eze', firstName: 'Chidi', sex: 'M', dateOfBirth: '2014-02-02', classArmId: cls }).expect(201)).body.student.id;
    const earlier = await teacher.get(`/attendance/register?classId=${cls}&date=${recent}`).expect(200);
    expect(earlier.body.students.map((x: { id: string }) => x.id)).not.toContain(late);
    const bad = { classId: cls, date: recent, marks: [kemi, tobi, late].map((id) => ({ studentId: id, status: 'PRESENT' })) };
    await teacher.put('/attendance/register', bad).expect(400);

    const stats = await schoolA.get('/stats').expect(200);
    expect(stats.body.attendanceToday).toMatchObject({ classes: 2 });
    const mine = await teacher.get('/my/classes').expect(200);
    expect(typeof mine.body.classes[0].registerTakenToday).toBe('boolean');
    expect(schoolBId).toBeTruthy();
  });

  it('lets the Ministry set holidays, and refuses registers on them', async () => {
    const h = weekday(3);
    await schoolA.post('/holidays', { name: 'Isese Day', startDate: h }).expect(403);
    await ministry.post('/holidays', { name: 'X', startDate: h }).expect(400);
    await ministry.post('/holidays', { name: 'Backwards', startDate: h, endDate: weekday(5) }).expect(400);
    const made = await ministry.post('/holidays', { name: 'Isese Day', startDate: h }).expect(201);
    expect(made.body).toMatchObject({ name: 'Isese Day', startDate: h, endDate: h, registersAlreadyTaken: 0 });
    await ministry.post('/holidays', { name: 'Isese Day', startDate: h }).expect(409);

    const refused = await teacher.put('/attendance/register', allPresent(h)).expect(400);
    expect(refused.body.message).toMatch(/holiday \(Isese Day\)/);
    await teacher.get(`/attendance/register?classId=${cls}&date=${h}`).expect(400);
    const day = await schoolA.get(`/attendance/day?date=${h}`).expect(200);
    expect(day.body).toMatchObject({ isSchoolDay: false, holiday: 'Isese Day' });

    const list = await teacher.get('/holidays').expect(200);
    expect(list.body.map((x: { name: string }) => x.name)).toContain('Isese Day');

    await ministry.del(`/holidays/${made.body.id}`).expect(200);
    await teacher.get(`/attendance/register?classId=${cls}&date=${h}`).expect(200);
    expect((await schoolA.get(`/attendance/day?date=${h}`).expect(200)).body.holiday).toBeNull();
  });

  it('adds the national holidays that fall in a session, once', async () => {
    const sessions = (await ministry.get('/sessions').expect(200)).body;
    const first = await ministry.post('/holidays/national', { sessionId: sessions[0].id }).expect(201);
    expect(first.body.added.length).toBeGreaterThan(0);
    const again = await ministry.post('/holidays/national', { sessionId: sessions[0].id }).expect(201);
    expect(again.body.added).toEqual([]);
    await schoolA.post('/holidays/national', { sessionId: sessions[0].id }).expect(403);
  });
});
