import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, Role } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/common/password';
import { setupApp } from '../src/setup-app';

/** Sessions, classes, enrolment, guardians, transfers and withdrawal. Erases the test database first. */
describe('Students and classes (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    get: (url: string) => http().get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => http().post(url).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    patch: (url: string, body: object) => http().patch(url).set('Authorization', `Bearer ${token}`).send(body),
    del: (url: string) => http().delete(url).set('Authorization', `Bearer ${token}`),
  });

  /** Signs in for the first time and swaps the temporary password, returning an access token. */
  async function activate(identifier: string, temp: string) {
    const first = await http().post('/auth/login').send({ identifier, password: temp }).expect(200);
    const r = await http()
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${first.body.accessToken}`)
      .send({ currentPassword: temp, newPassword: 'Permanent2026' })
      .expect(200);
    return r.body.accessToken as string;
  }

  let ministry: ReturnType<typeof as>;
  let schoolA: ReturnType<typeof as>;
  let schoolB: ReturnType<typeof as>;
  let teacher: ReturnType<typeof as>;
  let parent: ReturnType<typeof as>;
  let schoolAId: string;
  let schoolBId: string;
  let session2: string;
  let jss2a: string;
  let jss2b: string;
  let ayo: { id: string; learnerId: string; admissionNumber: string };
  let twin: string;
  let teacherId: string;

  beforeAll(async () => {
    process.env.COOKIE_SECURE = 'false';
    process.env.LOGIN_RATE_LIMIT = '1000';
    process.env.JWT_ACCESS_SECRET ??= 'test-secret-test-secret-test-secret-123';
    prisma = new PrismaClient();
    await prisma.$executeRawUnsafe(
      'TRUNCATE "SmsMessage", "Holiday", "AuditLog", "RefreshToken", "Transfer", "StudentGuardian", "ClassPlacement", "Enrolment", "Student", "ClassArm", "AcademicSession", "Counter", "User", "School" CASCADE',
    );
    await prisma.user.create({
      data: { fullName: 'Ministry Admin', email: 'admin@moe.test', role: Role.MINISTRY_ADMIN, passwordHash: await hashPassword('Temp1234x') },
    });
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    setupApp(app);
    await app.init();
    ministry = as(await activate('admin@moe.test', 'Temp1234x'));

    const a = await ministry
      .post('/schools', { name: 'Osogbo Model Secondary School', lga: 'Osogbo', level: 'JUNIOR_AND_SENIOR', ownership: 'PUBLIC', admin: { fullName: 'Principal A', email: 'a@school.test' } })
      .expect(201);
    schoolAId = a.body.school.id;
    schoolA = as(await activate('a@school.test', a.body.admin.tempPassword));
    const b = await ministry
      .post('/schools', { name: 'Community High School', lga: 'Iwo', level: 'JUNIOR_AND_SENIOR', ownership: 'PUBLIC', admin: { fullName: 'Principal B', email: 'b@school.test' } })
      .expect(201);
    schoolBId = b.body.school.id;
    schoolB = as(await activate('b@school.test', b.body.admin.tempPassword));
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('needs a current session before classes can be created', async () => {
    const r = await schoolA.post('/classes', { level: 'JSS_2', arm: 'A' }).expect(400);
    expect(r.body.message).toMatch(/current academic session/);
  });

  it('lets the Ministry create sessions; the first becomes current', async () => {
    await ministry.post('/sessions', { name: '2025/2027', startDate: '2025-09-15', endDate: '2026-07-17' }).expect(400);
    await schoolA.post('/sessions', { name: '2025/2026', startDate: '2025-09-15', endDate: '2026-07-17' }).expect(403);
    const s1 = await ministry.post('/sessions', { name: '2025/2026', startDate: '2025-09-15', endDate: '2026-07-17' }).expect(201);
    expect(s1.body.isCurrent).toBe(true);
    const s2 = await ministry.post('/sessions', { name: '2026/2027', startDate: '2026-09-14', endDate: '2027-07-16' }).expect(201);
    expect(s2.body.isCurrent).toBe(false);
    session2 = s2.body.id;
    const cur = await schoolA.get('/sessions/current').expect(200);
    expect(cur.body.name).toBe('2025/2026');
  });

  it('lets a school create classes only for the levels it teaches', async () => {
    const levels = await schoolA.get('/classes/levels').expect(200);
    expect(levels.body).toEqual(['JSS_1', 'JSS_2', 'JSS_3', 'SSS_1', 'SSS_2', 'SSS_3']);
    await schoolA.post('/classes', { level: 'PRIMARY_1', arm: 'A' }).expect(400);
    const c = await schoolA.post('/classes', { level: 'JSS_2', arm: 'a', capacity: 2 }).expect(201);
    expect(c.body.name).toBe('JSS 2A');
    jss2a = c.body.id;
    await schoolA.post('/classes', { level: 'JSS_2', arm: 'A' }).expect(409);
    jss2b = (await schoolA.post('/classes', { level: 'JSS_2', arm: 'B' }).expect(201)).body.id;
    await schoolB.patch(`/classes/${jss2a}`, { capacity: 30 }).expect(404);
  });

  it('assigns a class teacher from the same school', async () => {
    const t = await schoolA.post('/users', { fullName: 'Tunde Olaniyan', email: 't@school.test', role: 'TEACHER' }).expect(201);
    teacherId = t.body.user.id;
    teacher = as(await activate('t@school.test', t.body.tempPassword));
    const other = await schoolB.post('/users', { fullName: 'Other Teacher', email: 'o@school.test', role: 'TEACHER' }).expect(201);
    await schoolA.patch(`/classes/${jss2a}`, { classTeacherId: other.body.user.id }).expect(400);
    const r = await schoolA.patch(`/classes/${jss2a}`, { classTeacherId: teacherId }).expect(200);
    expect(r.body.classTeacher.fullName).toBe('Tunde Olaniyan');
  });

  it('enrols a student into a class with a new parent account', async () => {
    const r = await schoolA
      .post('/students', {
        surname: 'Adeleke', firstName: 'Ayomide', sex: 'F', dateOfBirth: '2013-04-02', classArmId: jss2a,
        guardian: { relationship: 'Mother', newParent: { fullName: 'Bisi Adeleke', phone: '08034125590' } },
      })
      .expect(201);
    expect(r.body.student.learnerId).toMatch(/^OSN-\d{2}-000001$/);
    expect(r.body.student.admissionNumber).toMatch(/^\d{4}\/0001$/);
    expect(r.body.student.currentClass.name).toBe('JSS 2A');
    expect(r.body.parent.tempPassword).toHaveLength(10);
    ayo = { id: r.body.student.id, learnerId: r.body.student.learnerId, admissionNumber: r.body.student.admissionNumber };
    parent = as(await activate('08034125590', r.body.parent.tempPassword));
  });

  it('rejects impossible dates of birth', async () => {
    await schoolA.post('/students', { surname: 'Too', firstName: 'Young', sex: 'M', dateOfBirth: '2025-01-01' }).expect(400);
    await schoolA.post('/students', { surname: 'Bad', firstName: 'Date', sex: 'M', dateOfBirth: '2013-02-30' }).expect(400);
  });

  it('warns about possible duplicates, and enforces class capacity', async () => {
    const dup = await schoolB.post('/students', { surname: 'ADELEKE', firstName: 'ayomide', sex: 'F', dateOfBirth: '2013-04-02' }).expect(409);
    expect(dup.body.code).toBe('POSSIBLE_DUPLICATE');
    expect(dup.body.matches[0].school).toBe('Osogbo Model Secondary School');

    twin = (await schoolA
      .post('/students', { surname: 'Adeleke', firstName: 'Ayomide', sex: 'F', dateOfBirth: '2013-04-02', classArmId: jss2a, confirmDuplicate: true })
      .expect(201)).body.student.id;
    const full = await schoolA.post('/students', { surname: 'Ojo', firstName: 'Babatunde', sex: 'M', dateOfBirth: '2012-11-20', classArmId: jss2a }).expect(400);
    expect(full.body.message).toMatch(/full/);
  });

  it("shows the class teacher their class and the parent their child, and no one else's", async () => {
    const mine = await teacher.get('/my/classes').expect(200);
    expect(mine.body.classes[0].name).toBe('JSS 2A');
    expect(mine.body.classes[0].students).toHaveLength(2);
    expect(mine.body.classes[0].students[0].guardians.length + mine.body.classes[0].students[1].guardians.length).toBe(1);

    const kids = await parent.get('/my/children').expect(200);
    expect(kids.body).toHaveLength(1);
    expect(kids.body[0]).toMatchObject({ learnerId: ayo.learnerId, relationship: 'Mother', classTeacher: 'Tunde Olaniyan' });
    await parent.get(`/students/${ayo.id}`).expect(200);
    await parent.get(`/students/${twin}`).expect(404);
    await schoolB.get(`/students/${ayo.id}`).expect(404);
    await schoolB.post(`/students/${ayo.id}/placement`, { classArmId: null }).expect(404);
  });

  it('moves a student between classes and finds unplaced students', async () => {
    const moved = await schoolA.post(`/students/${twin}/placement`, { classArmId: jss2b }).expect(201);
    expect(moved.body.currentClass.name).toBe('JSS 2B');
    await teacher.get(`/students/${twin}`).expect(404);
    await schoolA.post(`/students/${twin}/placement`, { classArmId: null }).expect(201);
    const unplaced = await schoolA.get('/students?unplaced=true').expect(200);
    expect(unplaced.body.map((s: { id: string }) => s.id)).toEqual([twin]);
    const search = await schoolA.get(`/students?q=${encodeURIComponent(ayo.admissionNumber)}`).expect(200);
    expect(search.body[0].id).toBe(ayo.id);
  });

  it('transfers a student when the receiving school accepts', async () => {
    const directory = await schoolA.get('/schools/directory').expect(200);
    expect(directory.body.map((s: { id: string }) => s.id)).toContain(schoolBId);

    const t = await schoolA.post('/transfers', { studentId: ayo.id, toSchoolId: schoolBId, reason: 'Family relocated to Iwo' }).expect(201);
    await schoolA.post('/transfers', { studentId: ayo.id, toSchoolId: schoolBId, reason: 'Again' }).expect(409);
    await schoolA.post(`/transfers/${t.body.id}/accept`).expect(404);

    const incoming = await schoolB.get('/transfers').expect(200);
    expect(incoming.body[0]).toMatchObject({ status: 'REQUESTED', fromSchool: { name: 'Osogbo Model Secondary School' }, student: { currentClass: 'JSS 2A' } });

    const bClass = (await schoolB.post('/classes', { level: 'JSS_2', arm: 'A' }).expect(201)).body.id;
    await schoolB.post(`/transfers/${t.body.id}/accept`, { classArmId: bClass }).expect(201);

    const rec = await schoolB.get(`/students/${ayo.id}`).expect(200);
    expect(rec.body.school.id).toBe(schoolBId);
    expect(rec.body.currentClass.name).toBe('JSS 2A');
    expect(rec.body.learnerId).toBe(ayo.learnerId);
    expect(rec.body.enrolments).toHaveLength(2);
    expect(rec.body.enrolments[0].leftReason).toBe('Transferred to Community High School');
    await schoolA.get(`/students/${ayo.id}`).expect(404);
    const kids = await parent.get('/my/children').expect(200);
    expect(kids.body[0].school.name).toBe('Community High School');
    // The parent's account follows their only child to the new school.
    const bParents = await schoolB.get('/users?role=PARENT').expect(200);
    expect(bParents.body.map((u: { phone: string }) => u.phone)).toContain('+2348034125590');
    const aParents = await schoolA.get('/users?role=PARENT').expect(200);
    expect(aParents.body.map((u: { phone: string }) => u.phone)).not.toContain('+2348034125590');
    const mine = await teacher.get('/my/classes').expect(200);
    expect(mine.body.classes[0].students).toHaveLength(0);
  });

  it('lets the receiving school reject and the sending school cancel', async () => {
    const t1 = await schoolA.post('/transfers', { studentId: twin, toSchoolId: schoolBId, reason: 'Parent request' }).expect(201);
    await schoolB.post(`/transfers/${t1.body.id}/reject`, { note: 'No space in JSS 2' }).expect(201);
    await schoolB.post(`/transfers/${t1.body.id}/accept`).expect(400);
    const t2 = await schoolA.post('/transfers', { studentId: twin, toSchoolId: schoolBId, reason: 'Second try' }).expect(201);
    await schoolA.post(`/transfers/${t2.body.id}/cancel`).expect(201);
    const all = await ministry.get('/transfers').expect(200);
    expect(all.body.map((t: { status: string }) => t.status).sort()).toEqual(['ACCEPTED', 'CANCELLED', 'REJECTED']);
  });

  it('withdraws a student and keeps the record', async () => {
    await schoolA.post(`/students/${twin}/withdraw`, { reason: 'Moved out of Osun State' }).expect(201);
    const active = await schoolA.get('/students').expect(200);
    expect(active.body).toHaveLength(0);
    const rec = await ministry.get(`/students/${twin}`).expect(200);
    expect(rec.body.status).toBe('WITHDRAWN');
    expect(rec.body.enrolments[0].leftReason).toBe('Withdrawn: Moved out of Osun State');
  });

  it('lets the Ministry search students state-wide', async () => {
    await ministry.get('/students').expect(400);
    const r = await ministry.get(`/students?q=${ayo.learnerId}`).expect(200);
    expect(r.body).toHaveLength(1);
    await teacher.get('/transfers').expect(403);
  });

  it('starts a new session with fresh classes', async () => {
    await ministry.post(`/sessions/${session2}/make-current`).expect(201);
    const classes = await schoolA.get('/classes').expect(200);
    expect(classes.body).toHaveLength(0);
    const stats = await schoolB.get('/stats').expect(200);
    expect(stats.body).toMatchObject({ session: '2026/2027', students: 1, unplaced: 1, classes: 0 });
  });
});
