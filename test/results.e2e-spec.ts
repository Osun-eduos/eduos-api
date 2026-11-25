import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, Role } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/common/password';
import { setupApp } from '../src/setup-app';

/** Terms, subjects, score entry and approval, remarks, release and report cards. Erases the test database first. */
describe('Results (e2e)', () => {
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
      .send({ currentPassword: temp, newPassword: 'Permanent2026' })
      .expect(200);
    return r.body.accessToken as string;
  }

  const DAY = 86_400_000;
  const now = new Date(new Date(Date.now() + 3_600_000).toISOString().slice(0, 10) + 'T00:00:00Z');
  const iso = (offset: number) => new Date(now.getTime() + offset * DAY).toISOString().slice(0, 10);

  let ministry: ReturnType<typeof as>;
  let school: ReturnType<typeof as>;
  let otherSchool: ReturnType<typeof as>;
  let grace: ReturnType<typeof as>; // class teacher of JSS 1A, teaches English
  let segun: ReturnType<typeof as>; // teaches Mathematics
  let parent: ReturnType<typeof as>;
  let schoolId: string;
  let segunId: string;
  let graceId: string;
  let cls: string;
  let term1: string;
  let eng: string;
  let mth: string;
  let mthSheet: string;
  let kemi: string;
  let tobi: string;
  let sade: string;

  beforeAll(async () => {
    process.env.COOKIE_SECURE = 'false';
    process.env.LOGIN_RATE_LIMIT = '1000';
    process.env.JWT_ACCESS_SECRET ??= 'test-secret-test-secret-test-secret-123';
    prisma = new PrismaClient();
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Score", "ScoreSheet", "ClassSubject", "ClassResult", "ReportRemark", "Term", "AttendanceMark", "AttendanceRegister", "AuditLog", "RefreshToken", "Transfer", "StudentGuardian", "ClassPlacement", "Enrolment", "Student", "ClassArm", "AcademicSession", "Counter", "User", "School" CASCADE',
    );
    await prisma.user.create({
      data: { fullName: 'Ministry Admin', email: 'admin@moe.test', role: Role.MINISTRY_ADMIN, passwordHash: await hashPassword('Temp1234x') },
    });
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    setupApp(app);
    await app.init();
    ministry = as(await activate('admin@moe.test', 'Temp1234x'));
    await ministry.post('/sessions', { name: '2040/2041', startDate: iso(-60), endDate: iso(240) }).expect(201);

    const a = await ministry
      .post('/schools', { name: 'Ikirun High School', lga: 'Ifelodun', level: 'JUNIOR_AND_SENIOR', ownership: 'PUBLIC', admin: { fullName: 'Principal Adewale', email: 'p@school.test' } })
      .expect(201);
    schoolId = a.body.school.id;
    school = as(await activate('p@school.test', a.body.admin.tempPassword));
    const b = await ministry
      .post('/schools', { name: 'Ila Grammar School', lga: 'Ila', level: 'JUNIOR_AND_SENIOR', ownership: 'PUBLIC', admin: { fullName: 'Principal Ila', email: 'ila@school.test' } })
      .expect(201);
    otherSchool = as(await activate('ila@school.test', b.body.admin.tempPassword));

    const g = await school.post('/users', { fullName: 'Grace Akinola', email: 'grace@school.test', role: 'TEACHER' }).expect(201);
    graceId = g.body.user.id;
    grace = as(await activate('grace@school.test', g.body.tempPassword));
    const s = await school.post('/users', { fullName: 'Segun Ojo', email: 'segun@school.test', role: 'TEACHER' }).expect(201);
    segunId = s.body.user.id;
    segun = as(await activate('segun@school.test', s.body.tempPassword));

    cls = (await school.post('/classes', { level: 'JSS_1', arm: 'A', classTeacherId: graceId }).expect(201)).body.id;
    const admittedOn = iso(-50);
    const k = await school
      .post('/students', {
        surname: 'Bello', firstName: 'Kemi', sex: 'F', dateOfBirth: '2014-03-09', classArmId: cls, admittedOn,
        guardian: { relationship: 'Father', newParent: { fullName: 'Musa Bello', phone: '08061112233' } },
      })
      .expect(201);
    kemi = k.body.student.id;
    parent = as(await activate('08061112233', k.body.parent.tempPassword));
    tobi = (await school.post('/students', { surname: 'Adio', firstName: 'Tobi', sex: 'M', dateOfBirth: '2014-07-21', classArmId: cls, admittedOn }).expect(201)).body.student.id;
    sade = (await school.post('/students', { surname: 'Ola', firstName: 'Sade', sex: 'F', dateOfBirth: '2014-01-30', classArmId: cls, admittedOn }).expect(201)).body.student.id;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('lets the Ministry set up terms with a score split that adds up to 100', async () => {
    const bad = await ministry
      .post('/terms', { number: 1, startDate: iso(-55), endDate: iso(30), components: [{ key: 'CA1', label: 'CA 1', max: 30 }, { key: 'EXAM', label: 'Exam', max: 60 }] })
      .expect(400);
    expect(bad.body.message).toMatch(/add up to 100/);
    await school.post('/terms', { number: 1, startDate: iso(-55), endDate: iso(30) }).expect(403);
    const t = await ministry.post('/terms', { number: 1, startDate: iso(-55), endDate: iso(30) }).expect(201);
    expect(t.body).toMatchObject({ name: 'First term', isCurrent: true, showPositions: true });
    expect(t.body.components.map((c: { key: string; max: number }) => `${c.key}:${c.max}`)).toEqual(['CA1:20', 'CA2:20', 'EXAM:60']);
    term1 = t.body.id;
    await ministry.post('/terms', { number: 2, startDate: iso(20), endDate: iso(100) }).expect(400);
    await ministry.post('/terms', { number: 1, startDate: iso(40), endDate: iso(100) }).expect(409);
    await ministry.post('/terms', { number: 3, startDate: iso(40), endDate: iso(100) }).expect(201);
    const two = await ministry.post('/terms', { number: 2, startDate: iso(120), endDate: iso(200) }).expect(400);
    expect(two.body.message).toMatch(/in order/);
    const cur = await school.get('/terms/current').expect(200);
    expect(cur.body.id).toBe(term1);
  });

  it('lets a school choose subjects for a class and who teaches them', async () => {
    const cat = await school.get('/subjects?level=JSS_1').expect(200);
    const codes = cat.body.map((s: { code: string }) => s.code);
    expect(codes).toContain('BSC');
    expect(codes).not.toContain('BIO');
    await school.post(`/classes/${cls}/subjects`, { subjectCode: 'BIO' }).expect(400);
    eng = (await school.post(`/classes/${cls}/subjects`, { subjectCode: 'ENG', teacherId: graceId }).expect(201)).body.id;
    mth = (await school.post(`/classes/${cls}/subjects`, { subjectCode: 'MTH' }).expect(201)).body.id;
    await school.post(`/classes/${cls}/subjects`, { subjectCode: 'MTH' }).expect(409);
    const foreign = (await otherSchool.post('/users', { fullName: 'Not Ours', email: 'x@ila.test', role: 'TEACHER' }).expect(201)).body.user.id;
    await school.patch(`/class-subjects/${mth}`, { teacherId: foreign }).expect(400);
    const set = await school.patch(`/class-subjects/${mth}`, { teacherId: segunId }).expect(200);
    expect(set.body.teacher.fullName).toBe('Segun Ojo');
    await grace.post(`/classes/${cls}/subjects`, { subjectCode: 'YOR' }).expect(403);

    const cls2 = (await school.post('/classes', { level: 'JSS_1', arm: 'B' }).expect(201)).body.id;
    const core = await school.post(`/classes/${cls2}/subjects/core`).expect(201);
    expect(core.body.map((s: { code: string }) => s.code)).toEqual(expect.arrayContaining(['ENG', 'MTH', 'BSC', 'BTE', 'CIV']));
    const yor = core.body.find((s: { code: string }) => s.code === 'YOR');
    await school.del(`/class-subjects/${yor.id}`).expect(204);
  });

  it('lets the subject teacher enter scores, with checks on each mark', async () => {
    const mine = await segun.get('/my/subjects').expect(200);
    expect(mine.body.subjects).toEqual([expect.objectContaining({ id: mth, name: 'Mathematics', class: expect.objectContaining({ name: 'JSS 1A' }), students: 3 })]);

    const empty = await segun.get(`/scoresheets?classSubjectId=${mth}`).expect(200);
    expect(empty.body).toMatchObject({ id: null, status: 'DRAFT', editable: true });
    expect(empty.body.students).toHaveLength(3);

    const viewByClassTeacher = await grace.get(`/scoresheets?classSubjectId=${mth}`).expect(200);
    expect(viewByClassTeacher.body.editable).toBe(false);
    await grace.put('/scoresheets', { classSubjectId: mth, scores: [{ studentId: kemi, marks: { CA1: 10 } }] }).expect(403);
    await otherSchool.get(`/scoresheets?classSubjectId=${mth}`).expect(404);

    const tooHigh = await segun.put('/scoresheets', { classSubjectId: mth, scores: [{ studentId: kemi, marks: { CA1: 25 } }] }).expect(400);
    expect(tooHigh.body.message).toMatch(/between 0 and 20/);
    await segun.put('/scoresheets', { classSubjectId: mth, scores: [{ studentId: kemi, marks: { CA1: 10.3 } }] }).expect(400);
    await segun.put('/scoresheets', { classSubjectId: mth, scores: [{ studentId: kemi, marks: { CA9: 10 } }] }).expect(400);

    const draft = await segun.put('/scoresheets', { classSubjectId: mth, scores: [{ studentId: kemi, marks: { CA1: 18, CA2: 17 } }] }).expect(200);
    mthSheet = draft.body.id;
    const k = draft.body.students.find((s: { id: string }) => s.id === kemi);
    expect(k).toMatchObject({ marks: { CA1: 18, CA2: 17, EXAM: null }, total: null });

    const early = await segun.post(`/scoresheets/${mthSheet}/submit`).expect(400);
    expect(early.body.message).toMatch(/Still missing/);

    const full = await segun
      .put('/scoresheets', {
        classSubjectId: mth,
        scores: [
          { studentId: kemi, marks: { EXAM: 50 } },
          { studentId: tobi, marks: { CA1: 10, CA2: 10, EXAM: 30 } },
          { studentId: sade, marks: { CA1: 15, CA2: 15.5, EXAM: 44.5 } },
        ],
      })
      .expect(200);
    expect(full.body.students.map((s: { total: number; grade: string }) => `${s.total}${s.grade}`)).toEqual(['50C', '85A', '75A']);
    expect(full.body.summary).toMatchObject({ complete: 3, average: 70, highest: 85, lowest: 50 });
  });

  it('runs submit, return with a note, resubmit and approve', async () => {
    const sub = await segun.post(`/scoresheets/${mthSheet}/submit`).expect(200);
    expect(sub.body).toMatchObject({ status: 'SUBMITTED', editable: false, submitted: { by: 'Segun Ojo' } });
    await segun.put('/scoresheets', { classSubjectId: mth, scores: [{ studentId: tobi, marks: { EXAM: 31 } }] }).expect(403);
    await segun.post(`/scoresheets/${mthSheet}/approve`).expect(403);

    const home = await school.get('/stats').expect(200);
    expect(home.body.scoresAwaitingApproval).toBe(1);

    await school.post(`/scoresheets/${mthSheet}/return`, {}).expect(400);
    const ret = await school.post(`/scoresheets/${mthSheet}/return`, { note: "Check Tobi's exam score." }).expect(200);
    expect(ret.body).toMatchObject({ status: 'RETURNED', returnNote: "Check Tobi's exam score." });
    const seen = await segun.get(`/scoresheets?classSubjectId=${mth}`).expect(200);
    expect(seen.body).toMatchObject({ status: 'RETURNED', editable: true });

    await segun.put('/scoresheets', { classSubjectId: mth, scores: [{ studentId: tobi, marks: { EXAM: 40 } }] }).expect(200);
    await segun.post(`/scoresheets/${mthSheet}/submit`).expect(200);
    const ok = await school.post(`/scoresheets/${mthSheet}/approve`).expect(200);
    expect(ok.body).toMatchObject({ status: 'APPROVED', decided: { by: 'Principal Adewale' }, returnNote: null });
  });

  it('shows the broadsheet with averages and positions, and blocks release until every subject is approved', async () => {
    const engScores = [
      { studentId: kemi, marks: { CA1: 15, CA2: 15, EXAM: 45 } },
      { studentId: tobi, marks: { CA1: 20, CA2: 20, EXAM: 50 } },
      { studentId: sade, marks: { CA1: 15, CA2: 15, EXAM: 45 } },
    ];
    const s = await grace.put('/scoresheets', { classSubjectId: eng, scores: engScores }).expect(200);
    await grace.post(`/scoresheets/${s.body.id}/submit`).expect(200);

    const before = await school.get(`/results/class?classId=${cls}`).expect(200);
    expect(before.body.canRelease).toBe(false);
    expect(before.body.blockers.join(' ')).toMatch(/Not approved yet: English/);
    await school.post('/results/release', { classId: cls }).expect(400);
    await ministry.get(`/results/class?classId=${cls}`).expect(404);

    await school.post(`/scoresheets/${s.body.id}/approve`).expect(200);
    const r = await grace.get(`/results/class?classId=${cls}`).expect(200);
    const row = (id: string) => r.body.students.find((x: { id: string }) => x.id === id);
    // Kemi: 85 + 75 = 80 avg; Tobi: 60 + 90 = 75; Sade: 75 + 75 = 75 (shares 2nd).
    expect(row(kemi)).toMatchObject({ average: 80, position: 1, totals: { MTH: 85, ENG: 75 } });
    expect(row(tobi)).toMatchObject({ average: 75, position: 2 });
    expect(row(sade)).toMatchObject({ average: 75, position: 2 });
    expect(r.body.canRelease).toBe(false); // the class teacher cannot release
    expect(r.body.canEditTeacherRemarks).toBe(true);
    expect(r.body.canEditPrincipalRemarks).toBe(false);
  });

  it('takes remarks from the class teacher and the principal', async () => {
    await grace.put('/results/remarks', { classId: cls, remarks: [{ studentId: kemi, principalRemark: 'Well done.' }] }).expect(403);
    await segun.put('/results/remarks', { classId: cls, remarks: [{ studentId: kemi, teacherRemark: 'Hi' }] }).expect(404);
    await grace.put('/results/remarks', { classId: cls, remarks: [{ studentId: kemi, teacherRemark: 'A hardworking and attentive student.' }] }).expect(200);
    const r = await school.put('/results/remarks', { classId: cls, remarks: [{ studentId: kemi, principalRemark: 'Excellent result. Keep it up.' }] }).expect(200);
    const k = r.body.students.find((x: { id: string }) => x.id === kemi);
    expect(k).toMatchObject({ teacherRemark: 'A hardworking and attentive student.', principalRemark: 'Excellent result. Keep it up.' });
  });

  it('keeps report cards from parents until release, then shows the full report card', async () => {
    await parent.get(`/report-cards/${kemi}?termId=${term1}`).expect(404);
    const preview = await school.get(`/report-cards/${kemi}`).expect(200);
    expect(preview.body.released).toBe(false);
    expect((await parent.get(`/report-cards/${kemi}/terms`).expect(200)).body).toEqual([]);

    await grace.post('/results/release', { classId: cls }).expect(403);
    const rel = await school.post('/results/release', { classId: cls }).expect(200);
    expect(rel.body.released.by).toBe('Principal Adewale');
    await school.post('/results/release', { classId: cls }).expect(400);

    const terms = await parent.get(`/report-cards/${kemi}/terms`).expect(200);
    expect(terms.body).toEqual([expect.objectContaining({ termId: term1, name: 'First term', className: 'JSS 1A', released: true })]);
    const card = await parent.get(`/report-cards/${kemi}?termId=${term1}`).expect(200);
    expect(card.body).toMatchObject({
      released: true,
      school: { name: 'Ikirun High School' },
      class: { name: 'JSS 1A', classTeacher: 'Grace Akinola', students: 3 },
      term: { name: 'First term', session: '2040/2041' },
      summary: { subjects: 2, total: 160, average: 80, position: '1st', outOf: 3 },
      remarks: { teacher: 'A hardworking and attentive student.', principal: 'Excellent result. Keep it up.' },
    });
    const m = card.body.subjects.find((x: { code: string }) => x.code === 'MTH');
    expect(m).toMatchObject({ total: 85, grade: 'A', remark: 'Excellent', classAverage: 73.3, highest: 85, lowest: 60, position: 1 });
    expect(card.body.gradingScale[0]).toMatchObject({ grade: 'A', min: 70 });
    await parent.get(`/report-cards/${tobi}?termId=${term1}`).expect(404);
  });

  it('locks scores after release and shares released results with the Ministry', async () => {
    await segun.put('/scoresheets', { classSubjectId: mth, scores: [{ studentId: tobi, marks: { EXAM: 41 } }] }).expect(403);
    await school.post(`/scoresheets/${mthSheet}/return`, { note: 'Too late now' }).expect(403);
    await grace.put('/results/remarks', { classId: cls, remarks: [{ studentId: kemi, teacherRemark: 'Changed' }] }).expect(403);

    const sheet = await ministry.get(`/results/class?classId=${cls}`).expect(200);
    expect(sheet.body.released).toBeTruthy();
    const sum = await ministry.get('/results/summary').expect(200);
    expect(sum.body.schools).toEqual([expect.objectContaining({ id: schoolId, classesReleased: 1, students: 3, entries: 6, passRate: 100 })]);
    const maths = sum.body.subjects.find((x: { code: string }) => x.code === 'MTH');
    expect(maths).toMatchObject({ entries: 3, average: 73.3, passRate: 100, creditRate: 100 });
    const own = await otherSchool.get('/results/summary').expect(200);
    expect(own.body.schools).toEqual([]);
  });

  it('hides positions when the Ministry switches them off, and protects the score split once scores exist', async () => {
    await ministry.patch(`/terms/${term1}`, { components: [{ key: 'CA', label: 'CA', max: 40 }, { key: 'EXAM', label: 'Exam', max: 60 }] }).expect(400);
    await ministry.patch(`/terms/${term1}`, { showPositions: false }).expect(200);
    const card = await parent.get(`/report-cards/${kemi}?termId=${term1}`).expect(200);
    expect(card.body.summary.position).toBeNull();
    expect(card.body.subjects[0].position).toBeNull();
    expect(segunId && graceId).toBeTruthy();
  });

  it('lets the Ministry choose WAEC or A to F grading for senior secondary, until SSS results are released', async () => {
    const terms = await school.get('/terms').expect(200);
    expect(terms.body.find((t: { id: string }) => t.id === term1).sssGrading).toBe('WAEC');
    await ministry.patch(`/terms/${term1}`, { sssGrading: 'GCE' }).expect(400);
    await school.patch(`/terms/${term1}`, { sssGrading: 'BASIC' }).expect(403);

    const sss = (await school.post('/classes', { level: 'SSS_1', arm: 'A', classTeacherId: graceId }).expect(201)).body.id;
    const tola = (await school.post('/students', { surname: 'Ajayi', firstName: 'Tola', sex: 'F', dateOfBirth: '2011-05-05', classArmId: sss, admittedOn: iso(-50) }).expect(201)).body.student.id;
    const bio = (await school.post(`/classes/${sss}/subjects`, { subjectCode: 'BIO', teacherId: segunId }).expect(201)).body.id;
    const sheet = await segun.put('/scoresheets', { classSubjectId: bio, scores: [{ studentId: tola, marks: { CA1: 15, CA2: 15, EXAM: 42 } }] }).expect(200);
    expect(sheet.body.students[0]).toMatchObject({ total: 72, grade: 'B2' });
    expect(sheet.body.term.sssGrading).toBe('WAEC');

    // Junior secondary results are already released, but SSS ones are not, so the scale can still change.
    const basic = await ministry.patch(`/terms/${term1}`, { sssGrading: 'BASIC' }).expect(200);
    expect(basic.body.sssGrading).toBe('BASIC');
    const again = await segun.get(`/scoresheets?classSubjectId=${bio}`).expect(200);
    expect(again.body.students[0].grade).toBe('A');
    // Junior secondary always uses A to F.
    const jss = await parent.get(`/report-cards/${kemi}?termId=${term1}`).expect(200);
    expect(jss.body.subjects.find((x: { code: string }) => x.code === 'MTH').grade).toBe('A');

    await segun.post(`/scoresheets/${sheet.body.id}/submit`).expect(200);
    await school.post(`/scoresheets/${sheet.body.id}/approve`).expect(200);
    await school.post('/results/release', { classId: sss }).expect(200);
    const card = await school.get(`/report-cards/${tola}?termId=${term1}`).expect(200);
    expect(card.body.subjects[0]).toMatchObject({ total: 72, grade: 'A', remark: 'Excellent' });
    expect(card.body.gradingScale.map((b: { grade: string }) => b.grade)).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);

    const locked = await ministry.patch(`/terms/${term1}`, { sssGrading: 'WAEC' }).expect(400);
    expect(locked.body.message).toMatch(/already been released/);
    await ministry.patch(`/terms/${term1}`, { sssGrading: 'BASIC' }).expect(200);
  });
});
