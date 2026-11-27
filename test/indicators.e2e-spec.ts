import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, Role } from '@prisma/client';
import { unzipSync, strFromU8 } from 'fflate';
import request from 'supertest';
import { completeTwoStep } from './helpers/two-step';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/common/password';
import { setupApp } from '../src/setup-app';

/** Education indicators and their exports. Builds two LGAs and two sessions. Erases the test database first. */
describe('Indicators (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    get: (url: string) => http().get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => http().post(url).set('Authorization', `Bearer ${token}`).send(body ?? {}),
  });
  async function activate(identifier: string, temp: string) {
    const first = await http().post('/auth/login').send({ identifier, password: temp }).expect(200);
    const r = await http().post('/auth/change-password').set('Authorization', `Bearer ${first.body.accessToken}`).send({ currentPassword: temp, newPassword: 'steady-maple-road-26' }).expect(200);
    return completeTwoStep(http, r);
  }
  const d = (s: string) => new Date(s + 'T00:00:00Z');
  let ministry: ReturnType<typeof as>;
  let officer: ReturnType<typeof as>;
  let school: ReturnType<typeof as>;
  let oldSession: string;
  let term1: string;
  let term2: string;

  beforeAll(async () => {
    process.env.COOKIE_SECURE = 'false';
    process.env.LOGIN_RATE_LIMIT = '1000';
    prisma = new PrismaClient();
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Notice", "Notification", "DeviceToken", "SmsMessage", "Holiday", "SyncEvent", "Score", "ScoreSheet", "ClassSubject", "ClassResult", "ReportRemark", "Term", "AttendanceMark", "AttendanceRegister", "AuditLog", "RefreshToken", "Transfer", "StudentGuardian", "ClassPlacement", "Enrolment", "Student", "ClassArm", "AcademicSession", "Counter", "User", "School" CASCADE',
    );
    const admin = await prisma.user.create({ data: { fullName: 'Ministry Admin', email: 'admin@moe.test', role: Role.MINISTRY_ADMIN, passwordHash: await hashPassword('Temp1234x') } });
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    setupApp(app);
    await app.init();
    ministry = as(await activate('admin@moe.test', 'Temp1234x'));

    // Two sessions: 2024/2025 (past) and 2025/2026 (current).
    const past = await prisma.academicSession.create({ data: { name: '2024/2025', startDate: d('2024-09-09'), endDate: d('2025-07-25') } });
    oldSession = past.id;
    const cur = await prisma.academicSession.create({ data: { name: '2025/2026', startDate: d('2025-09-08'), endDate: d('2026-07-24'), isCurrent: true } });
    const comps = [{ key: 'EXAM', label: 'Exam', max: 100 }];
    term1 = (await prisma.term.create({ data: { sessionId: cur.id, number: 1, startDate: d('2025-09-08'), endDate: d('2025-12-12'), components: comps } })).id;
    term2 = (await prisma.term.create({ data: { sessionId: cur.id, number: 2, startDate: d('2026-01-05'), endDate: d('2026-04-02'), components: comps, isCurrent: true } })).id;

    const osogbo = await prisma.school.create({ data: { code: 'OS/OSG/COM/0001', name: 'Osogbo Grammar', lga: 'Osogbo', level: 'JUNIOR_AND_SENIOR', ownership: 'PUBLIC' } });
    const osogbo2 = await prisma.school.create({ data: { code: 'OS/OSG/COM/0002', name: 'Baptist High', lga: 'Osogbo', level: 'JUNIOR_AND_SENIOR', ownership: 'PUBLIC' } });
    const iwo = await prisma.school.create({ data: { code: 'OS/IWO/COM/0001', name: 'Iwo High', lga: 'Iwo', level: 'PRIMARY', ownership: 'PUBLIC' } });

    // Students: Osogbo Grammar 3 girls 1 boy in JSS 1A (current), Baptist 1 boy SSS 1, Iwo 2 boys primary 4. Past session: Osogbo Grammar 1 girl.
    let n = 0;
    const student = async (sex: 'F' | 'M', schoolId: string) =>
      prisma.student.create({ data: { learnerId: `OSN-25-${String(++n).padStart(6, '0')}`, surname: 'S', firstName: `N${n}`, sex, dateOfBirth: d('2013-01-01'), currentSchoolId: schoolId } });
    const cls = async (schoolId: string, sessionId: string, level: 'JSS_1' | 'SSS_1' | 'PRIMARY_4') => prisma.classArm.create({ data: { schoolId, sessionId, level, arm: 'A' } });
    const jss1 = await cls(osogbo.id, cur.id, 'JSS_1');
    const sss1 = await cls(osogbo2.id, cur.id, 'SSS_1');
    const p4 = await cls(iwo.id, cur.id, 'PRIMARY_4');
    const oldCls = await cls(osogbo.id, past.id, 'JSS_1');
    const place = (studentId: string, classArmId: string, sessionId: string) => prisma.classPlacement.create({ data: { studentId, classArmId, sessionId } });
    const g = [await student('F', osogbo.id), await student('F', osogbo.id), await student('F', osogbo.id)];
    const b = await student('M', osogbo.id);
    for (const s of [...g, b]) await place(s.id, jss1.id, cur.id);
    await place((await student('M', osogbo2.id)).id, sss1.id, cur.id);
    for (const _ of [1, 2]) await place((await student('M', iwo.id)).id, p4.id, cur.id);
    await place(g[0].id, oldCls.id, past.id);

    // Staff: Osogbo Grammar has 2 teachers now (one qualified, one with TRCN) and a bursar; Iwo has 1 teacher who
    // was at Osogbo Grammar last session.
    const staff = async (category: 'TEACHING' | 'NON_TEACHING', trcn?: string) =>
      prisma.staff.create({ data: { staffNumber: `OSN-ST-${String(++n).padStart(6, '0')}`, surname: 'T', firstName: `S${n}`, sex: 'F', category, trcnNumber: trcn, subjects: [] } });
    const t1 = await staff('TEACHING');
    await prisma.qualification.create({ data: { staffId: t1.id, kind: 'NCE' } });
    const t2 = await staff('TEACHING', 'TRCN/1');
    await prisma.qualification.create({ data: { staffId: t2.id, kind: 'B.Sc' } });
    const bursar = await staff('NON_TEACHING');
    const t3 = await staff('TEACHING');
    for (const s of [t1, t2, bursar]) await prisma.posting.create({ data: { staffId: s.id, schoolId: osogbo.id, startDate: d('2020-01-01') } });
    await prisma.posting.create({ data: { staffId: t3.id, schoolId: osogbo.id, startDate: d('2019-01-01'), endDate: d('2025-08-01') } });
    await prisma.posting.create({ data: { staffId: t3.id, schoolId: iwo.id, startDate: d('2025-08-01') } });

    // Attendance in JSS 1A: two term-1 days (8 marks: 6 present, 1 late, 1 absent) and one term-2 day (4 absent).
    const reg = async (date: string, statuses: string[]) => {
      const r = await prisma.attendanceRegister.create({ data: { classArmId: jss1.id, date: d(date), takenById: admin.id } });
      const all = [...g, b];
      for (const [i, st] of statuses.entries()) await prisma.attendanceMark.create({ data: { registerId: r.id, studentId: all[i].id, status: st as 'PRESENT' } });
    };
    await reg('2025-10-06', ['PRESENT', 'PRESENT', 'PRESENT', 'LATE']);
    await reg('2025-10-07', ['PRESENT', 'PRESENT', 'PRESENT', 'ABSENT']);
    await reg('2026-01-12', ['ABSENT', 'ABSENT', 'ABSENT', 'ABSENT']);

    // Results: JSS 1A maths, term 1 released (girls 80, 45, 30; boy 60), term 2 released (all 70); SSS 1 term 1 NOT released.
    const maths = await prisma.classSubject.create({ data: { classArmId: jss1.id, subjectCode: 'MTH' } });
    const sheet = async (termId: string, totals: number[], released: boolean, classSubjectId = maths.id, students = [...g, b]) => {
      const sh = await prisma.scoreSheet.create({ data: { classSubjectId, termId, status: 'APPROVED' } });
      for (const [i, t] of totals.entries()) await prisma.score.create({ data: { sheetId: sh.id, studentId: students[i].id, marks: { EXAM: t }, total: t } });
      const cs = await prisma.classSubject.findUniqueOrThrow({ where: { id: classSubjectId } });
      if (released) await prisma.classResult.create({ data: { classArmId: cs.classArmId, termId, releasedById: admin.id } });
    };
    await sheet(term1, [80, 45, 30, 60], true);
    await sheet(term2, [70, 70, 70, 70], true);
    const sssMaths = await prisma.classSubject.create({ data: { classArmId: sss1.id, subjectCode: 'MTH' } });
    const sssStudent = await prisma.classPlacement.findFirstOrThrow({ where: { classArmId: sss1.id } });
    await sheet(term1, [10], false, sssMaths.id, [{ id: sssStudent.studentId } as typeof b]);

    // Inspections: Osogbo Grammar visited twice (latest POOR), Iwo once (GOOD).
    const insp = (schoolId: string, visitedOn: string, overall: string, c: string) =>
      prisma.inspection.create({ data: { clientId: c, schoolId, inspectorId: admin.id, visitedOn: d(visitedOn), answers: {}, overall } });
    await insp(osogbo.id, '2025-10-01', 'GOOD', 'i1');
    await insp(osogbo.id, '2026-02-01', 'POOR', 'i2');
    await insp(iwo.id, '2025-11-01', 'GOOD', 'i3');

    const o = await ministry.post('/users', { fullName: 'Osogbo Officer', email: 'o@x.test', role: 'LGA_OFFICER', lga: 'Osogbo' }).expect(201);
    officer = as(await activate('o@x.test', o.body.tempPassword));
    const sa = await prisma.user.create({ data: { fullName: 'Head', email: 'h@x.test', role: Role.SCHOOL_ADMIN, schoolId: osogbo.id, passwordHash: await hashPassword('Temp1234x') } });
    school = as(await activate(sa.email!, 'Temp1234x'));
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('gives the Ministry state totals and one row per LGA', async () => {
    const r = (await ministry.get('/indicators').expect(200)).body;
    expect(r.scope).toMatchObject({ level: 'state', label: 'Osun State' });
    expect(r.session.name).toBe('2025/2026');
    expect(r.totals).toMatchObject({
      schools: 3, classes: 3, students: 7, girls: 3, boys: 4, gpi: 0.75, byStage: { primary: 2, jss: 4, sss: 1 },
      teachers: 3, nonTeachingStaff: 1, pupilsPerTeacher: 2.3, qualifiedTeachers: 33.3, trcnTeachers: 33.3,
      attendanceRate: 58.3, // (6 + 1) of 12 marks
      resultEntries: 8, average: 61.9, passRate: 87.5, creditRate: 75, // 7 of 8 are 40 or more; 6 of 8 are 50 or more
      passRateGirls: 83.3, passRateBoys: 100, inspected: 2, condition: { good: 1, poor: 1, fair: 0, critical: 0 },
    });
    expect(r.breakdown.map((x: { name: string }) => x.name)).toEqual(['Iwo', 'Osogbo']);
    expect(r.breakdown[0].figures).toMatchObject({ schools: 1, students: 2, teachers: 1, pupilsPerTeacher: 2, resultEntries: 0, passRate: null });
    expect(r.terms.map((t: { name: string }) => t.name)).toEqual(['First term', 'Second term']);
  });

  it('narrows results and attendance to one term', async () => {
    const r = (await ministry.get(`/indicators?termId=${term1}`).expect(200)).body;
    expect(r.term.name).toBe('First term');
    expect(r.totals).toMatchObject({ resultEntries: 4, average: 53.8, passRate: 75, attendanceRate: 87.5 });
    await ministry.get(`/indicators?sessionId=${oldSession}&termId=${term1}`).expect(400);
  });

  it('shows a past session as it was, with staff as on its last day', async () => {
    const r = (await ministry.get(`/indicators?sessionId=${oldSession}`).expect(200)).body;
    expect(r).toMatchObject({ session: { name: '2024/2025', isCurrent: false }, staffAsOf: '2025-07-25' });
    expect(r.totals).toMatchObject({ students: 1, girls: 1, boys: 0, gpi: null, teachers: 3, resultEntries: 0 });
    expect(r.breakdown.find((x: { name: string }) => x.name === 'Osogbo').figures.teachers).toBe(3);
  });

  it('holds an LGA officer to their LGA, school by school', async () => {
    const r = (await officer.get('/indicators').expect(200)).body;
    expect(r.scope).toMatchObject({ level: 'lga', lga: 'Osogbo', label: 'Osogbo LGA' });
    expect(r.breakdown.map((x: { name: string }) => x.name)).toEqual(['Baptist High', 'Osogbo Grammar']);
    expect(r.totals.students).toBe(5);
    await officer.get('/indicators?lga=Iwo').expect(404);
    await ministry.get('/indicators?lga=Lagos').expect(400);
    expect((await ministry.get('/indicators?lga=Iwo').expect(200)).body.breakdown[0].name).toBe('Iwo High');
    await school.get('/indicators').expect(403);
  });

  it('shows trends across sessions and month by month', async () => {
    const t = (await ministry.get('/indicators/trends').expect(200)).body;
    expect(t.bySession.map((s: { session: string; students: number }) => [s.session, s.students])).toEqual([['2024/2025', 1], ['2025/2026', 7]]);
    expect(t.attendanceByMonth).toEqual([{ month: '2025-10', attendanceRate: 87.5, marks: 8 }, { month: '2026-01', attendanceRate: 0, marks: 4 }]);
  });

  it('exports CSV, Excel and PDF, and records each export', async () => {
    const csv = await ministry.get('/indicators/export?format=csv').expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['content-disposition']).toBe('attachment; filename="osun-eduos-indicators-osun-state-2025-2026.csv"');
    const lines = csv.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toMatch(/^LGA,Schools,Students,Girls,Boys,Gender parity index/);
    expect(lines).toHaveLength(4);
    expect(lines[3]).toMatch(/^Total,3,7,3,4,0.75,/);

    const xlsx = await ministry.get(`/indicators/export?format=xlsx&termId=${term1}`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    const files = unzipSync(new Uint8Array(xlsx.body as Buffer));
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet4.xml']));
    expect(strFromU8(files['xl/workbook.xml'])).toContain('name="By LGA"');
    expect(strFromU8(files['xl/worksheets/sheet1.xml'])).toContain('First term');

    const pdf = await officer.get('/indicators/export?format=pdf').buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.headers['content-disposition']).toContain('osogbo-lga');
    await ministry.get('/indicators/export?format=doc').expect(400);
    expect(await prisma.auditLog.count({ where: { action: 'indicators.exported' } })).toBe(3);
  });
});
