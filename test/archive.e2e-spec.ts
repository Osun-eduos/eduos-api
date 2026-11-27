import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, Role } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/common/password';
import { setupApp } from '../src/setup-app';

/** Past sessions stay readable and cannot be changed. Erases the test database first. */
describe('Archive of past sessions (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    get: (url: string) => http().get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => http().post(url).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    put: (url: string, body: object) => http().put(url).set('Authorization', `Bearer ${token}`).send(body),
  });
  async function activate(identifier: string, temp: string) {
    const first = await http().post('/auth/login').send({ identifier, password: temp }).expect(200);
    const r = await http().post('/auth/change-password').set('Authorization', `Bearer ${first.body.accessToken}`).send({ currentPassword: temp, newPassword: 'steady-maple-road-26' }).expect(200);
    return r.body.accessToken as string;
  }
  const d = (s: string) => new Date(s + 'T00:00:00Z');
  let school: ReturnType<typeof as>;
  let ministry: ReturnType<typeof as>;
  let parent: ReturnType<typeof as>;
  let teacher: ReturnType<typeof as>;
  let past: string;
  let pastClass: string;
  let pastTerm: string;
  let maths: string;
  let ada: string;
  let schoolId: string;

  beforeAll(async () => {
    process.env.COOKIE_SECURE = 'false';
    process.env.LOGIN_RATE_LIMIT = '1000';
    prisma = new PrismaClient();
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Notice", "Notification", "DeviceToken", "SmsMessage", "Holiday", "SyncEvent", "Score", "ScoreSheet", "ClassSubject", "ClassResult", "ReportRemark", "Term", "AttendanceMark", "AttendanceRegister", "AuditLog", "RefreshToken", "Transfer", "StudentGuardian", "ClassPlacement", "Enrolment", "Student", "ClassArm", "AcademicSession", "Counter", "User", "School" CASCADE',
    );
    const pw = await hashPassword('Temp1234x');
    const admin = await prisma.user.create({ data: { fullName: 'Ministry Admin', email: 'admin@moe.test', role: Role.MINISTRY_ADMIN, passwordHash: pw } });
    const s = await prisma.school.create({ data: { code: 'OS/OSG/COM/0001', name: 'Osogbo Grammar', lga: 'Osogbo', level: 'JUNIOR_AND_SENIOR', ownership: 'PUBLIC' } });
    schoolId = s.id;
    const head = await prisma.user.create({ data: { fullName: 'Head', email: 'h@x.test', role: Role.SCHOOL_ADMIN, schoolId: s.id, passwordHash: pw } });
    const t = await prisma.user.create({ data: { fullName: 'Teacher', email: 't@x.test', role: Role.TEACHER, schoolId: s.id, passwordHash: pw } });
    const mum = await prisma.user.create({ data: { fullName: 'Mum', email: 'm@x.test', role: Role.PARENT, schoolId: s.id, passwordHash: pw } });

    // Last session, closed, with a class, a released term, a register and an unreleased second term.
    const ps = await prisma.academicSession.create({ data: { name: '2024/2025', startDate: d('2024-09-09'), endDate: d('2025-07-25') } });
    past = ps.id;
    const comps = [{ key: 'EXAM', label: 'Exam', max: 100 }];
    pastTerm = (await prisma.term.create({ data: { sessionId: ps.id, number: 1, startDate: d('2024-09-09'), endDate: d('2024-12-13'), components: comps } })).id;
    const pastTerm2 = (await prisma.term.create({ data: { sessionId: ps.id, number: 2, startDate: d('2025-01-06'), endDate: d('2025-04-04'), components: comps } })).id;
    const c = await prisma.classArm.create({ data: { schoolId: s.id, sessionId: ps.id, level: 'JSS_1', arm: 'A', classTeacherId: t.id } });
    pastClass = c.id;
    const st = await prisma.student.create({ data: { learnerId: 'OSN-24-000001', surname: 'Bello', firstName: 'Ada', sex: 'F', dateOfBirth: d('2012-01-01'), currentSchoolId: s.id } });
    ada = st.id;
    await prisma.enrolment.create({ data: { studentId: st.id, schoolId: s.id, admissionNumber: '2024/0001', admittedOn: d('2024-09-09') } });
    await prisma.classPlacement.create({ data: { studentId: st.id, classArmId: c.id, sessionId: ps.id } });
    await prisma.studentGuardian.create({ data: { studentId: st.id, parentId: mum.id, relationship: 'Mother' } });
    const cs = await prisma.classSubject.create({ data: { classArmId: c.id, subjectCode: 'MTH', teacherId: t.id } });
    maths = cs.id;
    const sheet = await prisma.scoreSheet.create({ data: { classSubjectId: cs.id, termId: pastTerm, status: 'APPROVED' } });
    await prisma.score.create({ data: { sheetId: sheet.id, studentId: st.id, marks: { EXAM: 72 }, total: 72 } });
    await prisma.classResult.create({ data: { classArmId: c.id, termId: pastTerm, releasedById: head.id } });
    await prisma.scoreSheet.create({ data: { classSubjectId: cs.id, termId: pastTerm2, status: 'DRAFT' } });
    const reg = await prisma.attendanceRegister.create({ data: { classArmId: c.id, date: d('2024-10-07'), takenById: t.id } });
    await prisma.attendanceMark.create({ data: { registerId: reg.id, studentId: st.id, status: 'PRESENT' } });

    // This session is current.
    const cur = await prisma.academicSession.create({ data: { name: '2025/2026', startDate: d('2025-09-08'), endDate: d('2026-07-24'), isCurrent: true } });
    await prisma.term.create({ data: { sessionId: cur.id, number: 1, startDate: d('2025-09-08'), endDate: d('2025-12-12'), components: comps, isCurrent: true } });

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    setupApp(app);
    await app.init();
    ministry = as(await activate(admin.email!, 'Temp1234x'));
    school = as(await activate(head.email!, 'Temp1234x'));
    teacher = as(await activate(t.email!, 'Temp1234x'));
    parent = as(await activate(mum.email!, 'Temp1234x'));
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('lists a past session\'s classes for the school and the Ministry', async () => {
    expect((await school.get(`/classes?sessionId=${past}`).expect(200)).body.map((c: { name: string; students: number }) => [c.name, c.students])).toEqual([['JSS 1A', 1]]);
    expect((await school.get('/classes').expect(200)).body).toEqual([]); // The current session has no classes yet.
    expect((await ministry.get(`/classes?sessionId=${past}&schoolId=${schoolId}`).expect(200)).body).toHaveLength(1);
    await school.get('/classes?sessionId=not-a-uuid').expect(400);
  });

  it('shows past results, report cards and attendance', async () => {
    const r = (await school.get(`/results/class?classId=${pastClass}&termId=${pastTerm}`).expect(200)).body;
    expect(r).toMatchObject({ term: { name: 'First term', session: '2024/2025', isCurrent: false }, canRelease: false, canEditTeacherRemarks: false, canEditPrincipalRemarks: false });
    expect(r.released).not.toBeNull();
    const card = (await parent.get(`/report-cards/${ada}?termId=${pastTerm}`).expect(200)).body;
    expect(card).toMatchObject({ released: true, term: { session: '2024/2025' }, subjects: [{ name: 'Mathematics', total: 72 }] });
    expect((await parent.get(`/report-cards/${ada}/terms`).expect(200)).body).toEqual([expect.objectContaining({ termId: pastTerm, session: '2024/2025', released: true })]);
    const att = (await school.get(`/attendance/class?classId=${pastClass}`).expect(200)).body;
    expect(att.days).toHaveLength(1);
  });

  it('refuses changes to a closed session', async () => {
    const reg = await school.put('/attendance/register', { classId: pastClass, date: '2024-10-08', marks: [{ studentId: ada, status: 'ABSENT' }] });
    expect(reg.status).toBe(403);
    expect(reg.body.message).toMatch(/2024\/2025 session is closed/);
    const scores = await teacher.put('/scoresheets', { classSubjectId: maths, scores: [{ studentId: ada, marks: { EXAM: 99 } }] });
    expect([400, 403]).toContain(scores.status);
    await school.post('/results/release', { classId: pastClass }).expect(400);
    await school.put('/results/remarks', { classId: pastClass, remarks: [{ studentId: ada, principalRemark: 'Changed later' }] }).expect((res) => expect([400, 403]).toContain(res.status));
    expect((await prisma.score.findFirstOrThrow()).total).toBe(72);
    expect(await prisma.reportRemark.count()).toBe(0);
  });
});
