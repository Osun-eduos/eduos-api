import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, Role } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/common/password';
import { newReportCode, promotion } from '../src/results/results.service';
import { planTerms } from '../src/sessions/sessions.controller';
import { setupApp } from '../src/setup-app';

/** A good school, answer by answer (as in inspections.e2e-spec). */
const goodAnswers = () => ({
  classrooms: { total: 12, usable: 12, condition: 'GOOD', roofLeaks: false, enoughSeats: true, boards: 'GOOD' },
  toilets: { girls: 4, boys: 4, staff: 2, working: 10, condition: 'GOOD', handwashing: true },
  water: { source: 'BOREHOLE', working: true, safe: true },
  power: { source: 'SOLAR', working: true },
  safety: { fence: 'FULL', gate: true, firstAid: true, fireExtinguisher: true, hazards: false },
  facilities: { library: true, laboratory: false, ict: false, playground: true },
});

describe('Report card helpers', () => {
  it('makes readable codes and says what the third term means', () => {
    expect(newReportCode()).toMatch(/^OSE-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    expect(promotion('JSS_2', 61)).toBe('Promoted to JSS 3');
    expect(promotion('PRIMARY_6', 61)).toBe('Completed primary school');
    expect(promotion('SSS_3', 40)).toBe('Completed senior secondary');
    expect(promotion('JSS_2', 39.5)).toBe('Promotion to be decided by the school');
    expect(promotion('JSS_2', null)).toBeNull();
  });

  it('lays out three terms with breaks between them', () => {
    const t = planTerms(new Date('2026-09-14'), [13, 12, 12], 3);
    expect(t.map((x) => [x.start.toISOString().slice(0, 10), x.end.toISOString().slice(0, 10)])).toEqual([
      ['2026-09-14', '2026-12-11'],
      ['2027-01-04', '2027-03-26'],
      ['2027-04-19', '2027-07-09'],
    ]);
  });
});

/** Features matched to the prototype. Erases the test database first. */
describe('Prototype parity (e2e)', () => {
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
    const r = await http().post('/auth/change-password').set('Authorization', `Bearer ${first.body.accessToken}`).send({ currentPassword: temp, newPassword: 'Permanent2026' }).expect(200);
    return r.body.accessToken as string;
  }
  const today = new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);
  const iso = (o: number) => new Date(Date.parse(today) + o * 86_400_000).toISOString().slice(0, 10);
  const weekend = [0, 6].includes(new Date(today).getUTCDay());

  let ministry: ReturnType<typeof as>;
  let school: ReturnType<typeof as>;
  let teacher: ReturnType<typeof as>;
  let parent: ReturnType<typeof as>;
  let inspector: ReturnType<typeof as>;
  let schoolId: string;
  let terms: { id: string; number: number; startDate: string; isCurrent: boolean }[];
  let armA: string;
  let armB: string;
  let teacherId: string;
  const kids: Record<string, string> = {};

  beforeAll(async () => {
    process.env.COOKIE_SECURE = 'false';
    process.env.LOGIN_RATE_LIMIT = '1000';
    process.env.JWT_ACCESS_SECRET ??= 'test-secret-test-secret-test-secret-123';
    prisma = new PrismaClient();
    await prisma.$executeRawUnsafe(
      'TRUNCATE "ReportCode", "ExamPaper", "PopulationEstimate", "Setting", "StaffAttendance", "Notice", "Notification", "DeviceToken", "SmsMessage", "Holiday", "SyncEvent", "Score", "ScoreSheet", "ClassSubject", "ClassResult", "ReportRemark", "Term", "AttendanceMark", "AttendanceRegister", "AuditLog", "RefreshToken", "Transfer", "StudentGuardian", "ClassPlacement", "Enrolment", "Student", "ClassArm", "AcademicSession", "Counter", "User", "School" CASCADE',
    );
    await prisma.user.create({ data: { fullName: 'Ministry Admin', email: 'admin@moe.test', role: Role.MINISTRY_ADMIN, passwordHash: await hashPassword('Temp1234x') } });
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    setupApp(app);
    await app.init();
    ministry = as(await activate('admin@moe.test', 'Temp1234x'));
  });

  afterAll(async () => {
    await prisma.setting.deleteMany({});
    await app.close();
    await prisma.$disconnect();
  });

  it('creates a session with its three terms in one step', async () => {
    await ministry.post('/sessions', { name: '2095/2096', startDate: iso(-30) }).expect(400);
    await ministry.post('/sessions', { name: '2095/2096', startDate: iso(-30), endDate: iso(100), terms: { weeks: [13, 12, 12], breakWeeks: 3 } }).expect(400);
    await ministry.post('/sessions', { name: '2095/2096', startDate: iso(-30), terms: { weeks: [13, 12, 30], breakWeeks: 3 } }).expect(400);
    const s = await ministry.post('/sessions', { name: '2095/2096', startDate: iso(-30), terms: { weeks: [13, 12, 12], breakWeeks: 3 } }).expect(201);
    expect(s.body).toMatchObject({ isCurrent: true, startDate: iso(-30), endDate: iso(-30 + 298) });
    terms = (await ministry.get('/terms').expect(200)).body;
    expect(terms.map((t) => [t.startDate, t.isCurrent])).toEqual([[iso(-30), true], [iso(-30 + 112), false], [iso(-30 + 217), false]]);
  });

  it('keeps a school profile with its location and facilities, and shows it awaits inspection', async () => {
    await ministry.post('/schools', { name: 'Osogbo Model School', lga: 'Osogbo', level: 'JUNIOR_AND_SENIOR', ownership: 'PUBLIC', latitude: 9.5, longitude: 4.5 }).expect(400);
    await ministry.post('/schools', { name: 'Osogbo Model School', lga: 'Osogbo', level: 'JUNIOR_AND_SENIOR', ownership: 'PUBLIC', facilities: ['SWIMMING'] }).expect(400);
    const a = await ministry.post('/schools', {
      name: 'Osogbo Model School', lga: 'Osogbo', level: 'JUNIOR_AND_SENIOR', ownership: 'PUBLIC', town: 'Osogbo', yearEstablished: 1978,
      latitude: 7.7719, longitude: 4.5624, classrooms: 18, expectedEnrolment: 600, facilities: ['WATER', 'POWER', 'WATER'],
      admin: { fullName: 'Mrs Adebisi', email: 'head@x.test' },
    }).expect(201);
    schoolId = a.body.school.id;
    expect(a.body.school).toMatchObject({ town: 'Osogbo', yearEstablished: 1978, latitude: 7.7719, facilities: ['WATER', 'POWER'] });
    school = as(await activate('head@x.test', a.body.admin.tempPassword));
    const list = (await ministry.get('/schools').expect(200)).body;
    expect(list[0]).toMatchObject({ pendingInspection: true, lastInspection: null, classrooms: 18 });

    await school.patch(`/schools/${schoolId}`, { classrooms: 20, facilities: ['WATER', 'LIBRARY'] }).expect(200);
    await school.patch(`/schools/${schoolId}`, { name: 'New name' }).expect(403);
    await school.patch(`/schools/${schoolId}`, { latitude: 7.7 }).expect(400);
    expect((await school.get(`/schools/${schoolId}`).expect(200)).body).toMatchObject({ classrooms: 20, facilities: ['WATER', 'LIBRARY'], pendingInspection: true });
  });

  it('texts the guardian the admission number, and allocates new students to arms evenly', async () => {
    armA = (await school.post('/classes', { level: 'JSS_1', arm: 'A', capacity: 3 }).expect(201)).body.id;
    armB = (await school.post('/classes', { level: 'JSS_1', arm: 'B', capacity: 3 }).expect(201)).body.id;
    await school.post('/students', { surname: 'Ade', firstName: 'Bad', sex: 'F', dateOfBirth: '2083-01-01', entryLevel: 'PRIMARY_1' }).expect(400);
    const age = (y: number) => `${Number(iso(-30).slice(0, 4)) - y}-01-15`;
    const k = await school.post('/students', {
      surname: 'Adeleke', firstName: 'Ayomide', sex: 'F', dateOfBirth: age(12), entryLevel: 'JSS_1', previousSchool: 'St Peter Primary School',
      guardian: { relationship: 'Mother', newParent: { fullName: 'Mrs Adeleke', phone: '08034125590' } },
    }).expect(201);
    kids.ayo = k.body.student.id;
    parent = as(await activate('08034125590', k.body.parent.tempPassword));
    const text = await prisma.smsMessage.findFirstOrThrow({ where: { kind: 'ENROLMENT' } });
    expect(text.body).toBe(`Ayomide Adeleke is now enrolled at Osogbo Model School. Admission no. ${k.body.student.admissionNumber}, learner ID ${k.body.student.learnerId}. - Osun EduOS`);
    expect((await parent.get('/notifications').expect(200)).body.items[0]).toMatchObject({ kind: 'ENROLMENT', title: 'Enrolment confirmed' });
    kids.tobi = (await school.post('/students', { surname: 'Ojo', firstName: 'Tobi', sex: 'M', dateOfBirth: age(13), entryLevel: 'JSS_1' }).expect(201)).body.student.id;
    kids.kemi = (await school.post('/students', { surname: 'Bello', firstName: 'Kemi', sex: 'F', dateOfBirth: age(12), entryLevel: 'JSS_1' }).expect(201)).body.student.id;
    kids.dayo = (await school.post('/students', { surname: 'Lawal', firstName: 'Dayo', sex: 'M', dateOfBirth: age(16), entryLevel: 'JSS_1' }).expect(201)).body.student.id;
    kids.none = (await school.post('/students', { surname: 'Raji', firstName: 'Halima', sex: 'F', dateOfBirth: age(12) }).expect(201)).body.student.id;
    expect((await school.get(`/students/${kids.ayo}`).expect(200)).body.previousSchool).toBe('St Peter Primary School');

    const before = (await school.get('/classes/allocation').expect(200)).body;
    expect(before.levels.find((l: { level: string }) => l.level === 'JSS_1').unplaced).toHaveLength(4);
    expect(before.unknown.map((u: { fullName: string }) => u.fullName)).toEqual(['Raji Halima']);
    expect((await school.post('/classes/auto-allocate', { level: 'JSS_1' }).expect(200)).body).toEqual({ placed: 4, full: 0 });
    const after = (await school.get('/classes/allocation').expect(200)).body.levels.find((l: { level: string }) => l.level === 'JSS_1');
    expect(after.arms.map((a: { students: number; girls: number; boys: number }) => [a.students, a.girls, a.boys])).toEqual([[2, 1, 1], [2, 1, 1]]);
    expect(after.unplaced).toEqual([]);
    expect((await school.post('/classes/auto-allocate', { level: 'JSS_1' }).expect(200)).body).toEqual({ placed: 0, full: 0 });
    await ministry.post('/classes/auto-allocate', { level: 'JSS_1' }).expect(403);
  });

  it('lets the Ministry change the grading scales, which every score sheet then uses', async () => {
    const g = (await school.get('/grading').expect(200)).body;
    expect(g.scales.BASIC[0]).toEqual({ min: 70, grade: 'A', remark: 'Excellent' });
    const basic = [{ min: 75, grade: 'A', remark: 'Excellent' }, { min: 60, grade: 'B', remark: 'Very good' }, { min: 50, grade: 'C', remark: 'Credit' }, { min: 40, grade: 'P', remark: 'Pass' }, { min: 0, grade: 'F', remark: 'Fail' }];
    await school.put('/grading', { BASIC: basic, SSS: g.scales.SSS }).expect(403);
    await ministry.put('/grading', { BASIC: basic.slice(0, 4), SSS: g.scales.SSS }).expect(400);
    await ministry.put('/grading', { BASIC: [...basic, { min: 60, grade: 'B2', remark: 'x' }], SSS: g.scales.SSS }).expect(400);
    const saved = (await ministry.put('/grading', { BASIC: [...basic].reverse(), SSS: g.scales.SSS }).expect(200)).body;
    expect(saved.scales.BASIC.map((b: { grade: string }) => b.grade)).toEqual(['A', 'B', 'C', 'P', 'F']);
  });

  it('approves every waiting score sheet at once, then analyses the class', async () => {
    const t = await school.post('/users', { fullName: 'Mr Olaniyan', email: 'olaniyan@x.test', role: 'TEACHER' }).expect(201);
    teacherId = t.body.user?.id ?? t.body.id;
    teacher = as(await activate('olaniyan@x.test', t.body.tempPassword));
    const mth = (await school.post(`/classes/${armA}/subjects`, { subjectCode: 'MTH', teacherId }).expect(201)).body.id;
    const eng = (await school.post(`/classes/${armA}/subjects`, { subjectCode: 'ENG' }).expect(201)).body.id;
    await school.post(`/classes/${armB}/subjects`, { subjectCode: 'MTH' }).expect(201);
    const roll = (await school.get(`/students?classId=${armA}&stats=true`).expect(200)).body;
    expect(roll[0]).toHaveProperty('attendanceRate', null);
    const ids = roll.map((r: { id: string }) => r.id);
    const marks = (a: number, b: number, e: number) => ({ CA1: a, CA2: b, EXAM: e });
    const sheet = await teacher.put('/scoresheets', { classSubjectId: mth, scores: [{ studentId: ids[0], marks: marks(18, 18, 38) }, { studentId: ids[1], marks: marks(10, 10, 24) }] }).expect(200);
    expect(sheet.body.students.map((s: { total: number; grade: string }) => [s.total, s.grade])).toEqual(expect.arrayContaining([[74, 'B'], [44, 'P']]));
    await teacher.post(`/scoresheets/${sheet.body.id}/submit`).expect(200);
    const e = await school.put('/scoresheets', { classSubjectId: eng, scores: [{ studentId: ids[0], marks: marks(15, 15, 40) }, { studentId: ids[1], marks: marks(5, 5, 20) }] }).expect(200);
    await school.post(`/scoresheets/${e.body.id}/submit`).expect(200);

    const sub = (await ministry.get('/results/submissions').expect(200)).body;
    expect(sub.schools[0]).toMatchObject({ name: 'Osogbo Model School', status: 'AWAITING_APPROVAL', sheets: { submitted: 2 } });
    await teacher.post('/scoresheets/approve-all').expect(403);
    expect((await school.post('/scoresheets/approve-all', {}).expect(200)).body).toEqual({ approved: 2 });

    const an = (await school.get(`/results/analysis?classId=${armA}`).expect(200)).body;
    expect(an.summary).toMatchObject({ students: 2, average: 54.5, passRate: 50, top: { average: 72 }, weakestSubject: { code: 'ENG', mean: 50 } });
    expect(an.subjects.find((s: { code: string }) => s.code === 'MTH')).toMatchObject({ scored: 2, mean: 59, highest: 74, lowest: 44, passRate: 100, distribution: { A: 0, B: 1, C: 0, P: 1, F: 0 } });
    expect(an.ranking.map((r: { position: string; grade: string }) => [r.position, r.grade])).toEqual([['1st', 'B'], ['2nd', 'F']]);
    expect(an.arms.rows.map((r: { name: string }) => r.name)).toEqual(['JSS 1A', 'JSS 1B']);
    await ministry.get(`/results/analysis?classId=${armA}`).expect(404); // not released yet

    await ministry.patch(`/terms/${terms[0].id}`, { resultsDueOn: iso(1) }).expect(200);
    await school.post('/results/release', { classId: armA }).expect(200);
    const after = (await ministry.get('/results/submissions').expect(200)).body;
    expect(after.term.resultsDueOn).toBe(iso(1));
    expect(after.schools[0]).toMatchObject({ status: 'PARTLY_RELEASED', classes: 2, released: 1 });
    expect(after.latest[0]).toMatchObject({ class: 'JSS 1A', students: 2, school: { name: 'Osogbo Model School' } });
    expect(after.summary).toMatchObject({ schools: 1, released: 0, partlyReleased: 1, overdue: false });
    expect((await ministry.get(`/results/analysis?classId=${armA}`).expect(200)).body.live).toBe(false);
  });

  it('prints an overall grade and a verification code anyone can check', async () => {
    const top = (await school.get(`/results/analysis?classId=${armA}`).expect(200)).body.ranking[0];
    const card = (await school.get(`/report-cards/${top.id}`).expect(200)).body;
    expect(card).toMatchObject({ overallGrade: { grade: 'B', remark: 'Very good' }, promotion: null });
    expect(card.verificationCode).toMatch(/^OSE-/);
    expect((await school.get(`/report-cards/${top.id}`).expect(200)).body.verificationCode).toBe(card.verificationCode);
    const v = (await http().get(`/verify/${card.verificationCode.toLowerCase()}`).expect(200)).body;
    expect(v).toMatchObject({ student: { fullName: card.student.fullName }, school: { name: 'Osogbo Model School' }, class: 'JSS 1A', average: 72, overallGrade: 'B', position: '1st of 2' });
    expect(v.subjects).toHaveLength(2);
    expect(v).not.toHaveProperty('guardians');
    await http().get('/verify/OSE-AAAA-AAAA').expect(404);
    const prog = (await school.get(`/report-cards/${top.id}/progress`).expect(200)).body;
    expect(prog).toEqual([expect.objectContaining({ term: 'First term', className: 'JSS 1A', average: 72, position: '1st of 2' })]);
    await http().get('/verify/<script>').expect(404);
  });

  it('closes score entry for a term when the Ministry says so', async () => {
    const mthB = (await school.get(`/classes/${armB}/subjects`).expect(200)).body[0].id;
    const roll = (await school.get(`/students?classId=${armB}`).expect(200)).body;
    await ministry.patch(`/terms/${terms[0].id}`, { scoresClosed: true }).expect(200);
    const r = await school.put('/scoresheets', { classSubjectId: mthB, scores: [{ studentId: roll[0].id, marks: { CA1: 10 } }] }).expect(403);
    expect(r.body.message).toMatch(/closed by the Ministry/);
    expect((await ministry.get('/terms').expect(200)).body[0].scoresClosed).toBe(true);
    await ministry.patch(`/terms/${terms[0].id}`, { scoresClosed: false }).expect(200);
    await school.put('/scoresheets', { classSubjectId: mthB, scores: [{ studentId: roll[0].id, marks: { CA1: 10 } }] }).expect(200);
  });

  it('keeps an exam timetable that parents can see', async () => {
    const day = (n: number) => {
      // The n-th weekday from today, inside the first term.
      let d = Date.parse(today);
      for (let i = 0; i < n; d += 86_400_000) if (![0, 6].includes(new Date(d + 86_400_000).getUTCDay())) i++;
      return new Date(d).toISOString().slice(0, 10);
    };
    const papers = [{ subjectCode: 'MTH', date: day(3), startTime: '09:00', minutes: 120 }, { subjectCode: 'ENG', date: day(3), startTime: '11:30', minutes: 90 }];
    await school.put('/exam-papers', { level: 'JSS_1', papers: [...papers, { subjectCode: 'PHY', date: day(4), startTime: '09:00', minutes: 60 }] }).expect(400);
    await school.put('/exam-papers', { level: 'JSS_1', papers: [papers[0], { ...papers[1], startTime: '10:30' }] }).expect(400);
    await school.put('/exam-papers', { level: 'JSS_1', papers: [{ ...papers[0], date: iso(400) }] }).expect(400);
    const saved = (await school.put('/exam-papers', { level: 'JSS_1', papers }).expect(200)).body;
    expect(saved.papers.map((p: { subject: string; startTime: string }) => [p.subject, p.startTime])).toEqual([['Mathematics', '09:00'], ['English', '11:30']]);
    const mine = (await parent.get(`/exam-papers/student/${kids.ayo}`).expect(200)).body;
    expect(mine).toMatchObject({ levelName: 'JSS 1', papers: [{ subjectCode: 'MTH' }, { subjectCode: 'ENG' }] });
    await parent.get(`/exam-papers/student/${kids.tobi}`).expect(404);
    expect((await teacher.get('/exam-papers?level=JSS_1').expect(200)).body.papers).toHaveLength(2);
  });

  it('sends notices to staff, and shows parents their school’s notices', async () => {
    const s = await school.post('/notices', { audience: 'STAFF', title: 'Staff meeting', body: 'Friday at 2 pm in the hall.' }).expect(201);
    expect(s.body).toMatchObject({ audience: 'All staff', recipients: 2 });
    await school.post('/notices', { audience: 'STAFF', classArmId: armA, title: 'Staff meeting', body: 'Friday at 2 pm.' }).expect(400);
    expect((await teacher.get('/notifications').expect(200)).body.items[0]).toMatchObject({ kind: 'NOTICE', title: 'Staff meeting' });
    await school.post('/notices', { title: 'PTA meeting', body: 'Saturday at 10 am in the school hall.' }).expect(201);
    const feed = (await parent.get('/notices/mine').expect(200)).body;
    expect(feed.map((n: { title: string }) => n.title)).toEqual(['PTA meeting']);
    expect(feed[0].school).toBe('Osogbo Model School');
    await school.get('/notices/mine').expect(403);
  });

  it('announces a term’s resumption to every parent once', async () => {
    await school.post(`/terms/${terms[1].id}/notify-resumption`, { sms: true }).expect(403);
    await ministry.post(`/terms/${terms[0].id}/notify-resumption`, { sms: true }).expect(400);
    const r = (await ministry.post(`/terms/${terms[1].id}/notify-resumption`, { sms: true }).expect(200)).body;
    expect(r).toEqual({ parents: 1, texts: 1 });
    expect((await prisma.smsMessage.findFirstOrThrow({ where: { kind: 'RESUMPTION' } })).body).toMatch(/^The second term of 2095\/2096 begins on \w+day \d+ \w+ \d{4}\. - Osun State Ministry of Education$/);
    await ministry.post(`/terms/${terms[1].id}/notify-resumption`, { sms: false }).expect(409);
  });

  it('keeps a staff register, lets teachers clock in, and reports training and shortages', async () => {
    const st = (await school.post('/staff', { surname: 'Olaniyan', firstName: 'Tunde', sex: 'M', category: 'TEACHING', subjects: ['MTH'] }).expect(201)).body;
    await school.patch(`/staff/${st.id}/account`, { userId: teacherId }).expect(200);
    const other = (await school.post('/staff', { surname: 'Ajibola', firstName: 'Funke', sex: 'F', category: 'TEACHING', subjects: ['ENG'] }).expect(201)).body;
    await school.post(`/staff/${st.id}/trainings`, { title: 'Numeracy', startDate: iso(-5), hours: 45 }).expect(201);
    await school.post(`/staff/${other.id}/trainings`, { title: 'Phonics', startDate: iso(-5), hours: 12 }).expect(201);

    if (weekend) {
      await teacher.post('/staff-attendance/clock-in').expect(400);
    } else {
      const c = (await teacher.post('/staff-attendance/clock-in').expect(200)).body;
      expect(['PRESENT', 'LATE']).toContain(c.status);
      expect((await teacher.post('/staff-attendance/clock-in').expect(200)).body.already).toBe(true);
      expect((await teacher.get('/staff-attendance/me').expect(200)).body.today.status).toBe(c.status);
    }
    await school.put('/staff-attendance', { date: iso(1), marks: [] }).expect(400);
    await school.put('/staff-attendance', { date: iso(-30), marks: [] }).expect(400);
    const reg = (await school.put('/staff-attendance', { date: today, marks: [{ staffId: st.id, status: 'PRESENT' }, { staffId: other.id, status: 'ABSENT' }] }).expect(200)).body;
    expect(reg.summary).toMatchObject({ staff: 2, marked: 2, PRESENT: 1, ABSENT: 1 });

    const ins = (await ministry.get('/staff/insights').expect(200)).body;
    expect(ins.attendance).toMatchObject({ staff: 2, marked: 2, present: 1, absent: 1, presentRate: 50, schools: 1, schoolsMarked: 1 });
    expect(ins.attendance.byLga[0]).toMatchObject({ lga: 'Osogbo', presentRate: 50 });
    expect(ins.training).toMatchObject({ targetHours: 40, teachers: 2, metTarget: 1, averageHours: 28.5 });
    expect(ins.shortages.subjects.find((x: { code: string }) => x.code === 'MTH')).toMatchObject({ pupils: 4, teachers: 1, needed: 1, shortfall: 0 });
    expect((await school.get('/staff/insights').expect(200)).body.attendance.byLga).toEqual([]);
    await teacher.get('/staff/insights').expect(403);
  });

  it('tracks minimum standards and follow-up on inspection reports', async () => {
    const i = await ministry.post('/users', { fullName: 'Mr Olayiwola', email: 'insp@x.test', role: 'INSPECTOR', lga: 'Osogbo' }).expect(201);
    inspector = as(await activate('insp@x.test', i.body.tempPassword));
    const answers = goodAnswers();
    answers.classrooms.usable = 1;
    answers.facilities.ict = true;
    const r = (await inspector.post('/inspections', { clientId: 'web-0001-abcdefgh', schoolId, visitedOn: today, answers }).expect(201)).body;
    expect(r.overall).toBe('CRITICAL');
    const std = (await ministry.get('/inspections/standards').expect(200)).body;
    expect(std.lgas[0]).toMatchObject({ lga: 'Osogbo', schools: 1, inspected: 1, water: 1, ict: 1, lab: 0, usable: 1, pupils: 5, needed: 1, shortfall: 0, needsAction: 1, noFollowUp: 1, rates: { water: 100, lab: 0 } });
    await inspector.patch(`/inspections/${r.id}/follow-up`, { status: 'URGENT' }).expect(403);
    await ministry.patch(`/inspections/${r.id}/follow-up`, { status: 'SOON' }).expect(400);
    const f = (await ministry.patch(`/inspections/${r.id}/follow-up`, { status: 'URGENT', note: 'Rebuild two classroom blocks.' }).expect(200)).body;
    expect(f.followUp).toMatchObject({ status: 'URGENT', note: 'Rebuild two classroom blocks.' });
    expect((await ministry.get('/inspections?followUp=URGENT').expect(200)).body).toHaveLength(1);
    expect((await ministry.get('/inspections?followUp=NONE').expect(200)).body).toHaveLength(0);
    expect((await ministry.get('/inspections/standards').expect(200)).body.state).toMatchObject({ urgent: 1, noFollowUp: 0 });
    expect((await ministry.get('/schools').expect(200)).body[0]).toMatchObject({ pendingInspection: false, lastInspection: { overall: 'CRITICAL' } });
  });

  it('works out enrolment ratios from population estimates, and pupils per classroom', async () => {
    const year = Number(iso(-30).slice(0, 4));
    const none = (await ministry.get('/indicators/access').expect(200)).body;
    expect(none.populationYear).toBeNull();
    expect(none.totals.stages[1]).toMatchObject({ stage: 'JSS', enrolled: 4, officialAge: 3, ger: null });
    await school.put('/indicators/population', { year, rows: [] }).expect(403);
    await ministry.put('/indicators/population', { year, rows: [{ lga: 'Lagos', stage: 'JSS', male: 1, female: 1 }] }).expect(400);
    const rows = [
      { lga: 'Osogbo', stage: 'PRIMARY', male: 3, female: 3 },
      { lga: 'Osogbo', stage: 'JSS', male: 2, female: 3 },
      { lga: 'Osogbo', stage: 'SSS', male: 1, female: 2, source: 'NPC projection' },
    ];
    expect((await ministry.put('/indicators/population', { year, rows }).expect(200)).body.rows).toHaveLength(3);
    const a = (await ministry.get('/indicators/access').expect(200)).body;
    expect(a.populationYear).toBe(year);
    expect(a.totals.stages[1]).toMatchObject({ population: 5, enrolled: 4, officialAge: 3, ger: 80, ner: 60 });
    // 14 children aged 6 to 17; 4 enrolled students are of school age (the fifth has no class).
    expect(a.totals).toMatchObject({ population: 14, outOfSchool: 10 });
    expect(a.byLga[0].lga).toBe('Osogbo');
    const ind = (await ministry.get('/indicators').expect(200)).body;
    expect(ind.totals).toMatchObject({ classrooms: 1, pupilsPerClassroom: 4 });
  });

  it('compares LGAs term by term and flags where support is needed', async () => {
    await ministry.get('/indicators/compare?lgas=Osogbo,Iwo,Ede North,Ilesa East').expect(400);
    await ministry.get('/indicators/compare?lgas=Gotham').expect(400);
    const c = (await ministry.get('/indicators/compare?lgas=Osogbo,Iwo').expect(200)).body;
    expect(c.terms).toHaveLength(1);
    expect(c.lgas.map((l: { name: string }) => l.name)).toEqual(['Osogbo', 'Iwo']);
    expect(c.lgas[0].points[0]).toMatchObject({ average: 54.5, passRate: 75, students: 4 });
    expect(c.lgas[1].points[0]).toMatchObject({ average: null, students: 0 });
    const o = (await ministry.get('/indicators/overview').expect(200)).body;
    expect(o.trend).toEqual([expect.objectContaining({ average: 54.5, passRate: 75 })]);
    expect(o.lgas).toEqual([expect.objectContaining({ lga: 'Osogbo', status: 'NEEDS_SUPPORT' })]);
    expect(o.lgas[0].reasons).toEqual(expect.arrayContaining(['100% of inspected schools critical']));
    expect(o.schoolsNeedingSupport[0]).toMatchObject({ name: 'Osogbo Model School', reasons: expect.arrayContaining(['Critical inspection']) });
  });
});
