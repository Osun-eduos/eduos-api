import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, Role } from '@prisma/client';
import request from 'supertest';
import { completeTwoStep } from './helpers/two-step';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/common/password';
import { setupApp } from '../src/setup-app';

/** Staff registry, postings, transfers and training. Erases the test database first. */
describe('Staff registry (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    get: (url: string) => http().get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => http().post(url).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    patch: (url: string, body: object) => http().patch(url).set('Authorization', `Bearer ${token}`).send(body),
    del: (url: string) => http().delete(url).set('Authorization', `Bearer ${token}`),
  });
  async function activate(identifier: string, temp: string) {
    const first = await http().post('/auth/login').send({ identifier, password: temp }).expect(200);
    const r = await http().post('/auth/change-password').set('Authorization', `Bearer ${first.body.accessToken}`).send({ currentPassword: temp, newPassword: 'steady-maple-road-26' }).expect(200);
    return completeTwoStep(http, r);
  }
  const now = new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);
  const iso = (o: number) => new Date(Date.parse(now) + o * 86_400_000).toISOString().slice(0, 10);

  let ministry: ReturnType<typeof as>;
  let schoolA: ReturnType<typeof as>;
  let schoolB: ReturnType<typeof as>;
  let officerB: ReturnType<typeof as>;
  let teacherToken: string;
  let teacherUserId: string;
  let aId: string;
  let bId: string;
  let grace: string;
  let clsA: string;

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
    await ministry.post('/sessions', { name: '2080/2081', startDate: iso(-60), endDate: iso(200) }).expect(201);
    const a = await ministry.post('/schools', { name: 'Ikire High School', lga: 'Irewole', level: 'JUNIOR_AND_SENIOR', ownership: 'PUBLIC', admin: { fullName: 'Head A', email: 'a@x.test' } }).expect(201);
    aId = a.body.school.id;
    schoolA = as(await activate('a@x.test', a.body.admin.tempPassword));
    const b = await ministry.post('/schools', { name: 'Ejigbo Grammar School', lga: 'Ejigbo', level: 'JUNIOR_AND_SENIOR', ownership: 'PUBLIC', admin: { fullName: 'Head B', email: 'b@x.test' } }).expect(201);
    bId = b.body.school.id;
    schoolB = as(await activate('b@x.test', b.body.admin.tempPassword));
    const o = await ministry.post('/users', { fullName: 'Officer B', email: 'ob@x.test', role: 'LGA_OFFICER', lga: 'Ejigbo' }).expect(201);
    officerB = as(await activate('ob@x.test', o.body.tempPassword));
    const t = await schoolA.post('/users', { fullName: 'Grace Akinola', email: 'g@x.test', role: 'TEACHER' }).expect(201);
    teacherUserId = t.body.user.id;
    teacherToken = await activate('g@x.test', t.body.tempPassword);
    clsA = (await schoolA.post('/classes', { level: 'JSS_1', arm: 'A', classTeacherId: teacherUserId }).expect(201)).body.id;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('lets a school add its staff, with checks', async () => {
    await schoolA.post('/staff', { surname: 'Akinola', firstName: 'Grace', sex: 'F', category: 'TEACHING', subjects: ['XYZ'] }).expect(400);
    await schoolA.post('/staff', { surname: 'Akinola', firstName: 'Grace', sex: 'F', category: 'TEACHING', dateOfBirth: '2020-01-01' }).expect(400);
    await as(teacherToken).post('/staff', { surname: 'X', firstName: 'Y', sex: 'F', category: 'TEACHING' }).expect(403);
    const r = await schoolA.post('/staff', {
      surname: 'Akinola', firstName: 'Grace', sex: 'F', category: 'TEACHING', rank: 'Teacher I', gradeLevel: 9, step: 3,
      dateOfBirth: '1988-04-12', firstAppointment: '2012-01-09', phone: '0803 222 3333', trcnNumber: 'TRCN/123', subjects: ['MTH', 'ENG', 'MTH'],
      schoolId: bId, // Ignored: schools add staff to their own school.
    }).expect(201);
    grace = r.body.id;
    expect(r.body).toMatchObject({ staffNumber: 'OSN-ST-000001', fullName: 'Akinola Grace', school: { id: aId }, subjects: ['MTH', 'ENG'], phone: '+2348032223333', status: 'ACTIVE' });
    expect(r.body.yearsOfService).toBeGreaterThanOrEqual(14);
    expect(r.body.postings).toHaveLength(1);
    await schoolA.post('/staff', { surname: 'Ojo', firstName: 'Bayo', sex: 'M', category: 'NON_TEACHING', rank: 'Bursar' }).expect(201);
    await ministry.post('/staff', { surname: 'Ade', firstName: 'Tunde', sex: 'M', category: 'TEACHING' }).expect(400);
    await ministry.post('/staff', { surname: 'Ade', firstName: 'Tunde', sex: 'M', category: 'TEACHING', schoolId: bId }).expect(201);
  });

  it('records qualifications and training, and links the sign-in account', async () => {
    await schoolA.post(`/staff/${grace}/qualifications`, { kind: 'Diploma' }).expect(400);
    await schoolA.post(`/staff/${grace}/qualifications`, { kind: 'B.Ed', course: 'Mathematics Education', institution: 'Obafemi Awolowo University', year: 2011 }).expect(201);
    await schoolA.post(`/staff/${grace}/trainings`, { title: 'Future date', startDate: iso(30) }).expect(400);
    const t = await ministry.post(`/staff/${grace}/trainings`, { title: 'Phonics and early literacy', provider: 'SUBEB', startDate: iso(-20), endDate: iso(-18), hours: 18 }).expect(201);
    expect(t.body.trainings[0]).toMatchObject({ title: 'Phonics and early literacy', hours: 18 });
    expect(t.body.qualifications[0]).toMatchObject({ kind: 'B.Ed', year: 2011 });
    const headB = (await schoolB.get('/staff').expect(200)).body;
    await schoolA.patch(`/staff/${grace}/account`, { userId: (await prisma.user.findFirstOrThrow({ where: { email: 'b@x.test' } })).id }).expect(400);
    expect((await schoolA.patch(`/staff/${grace}/account`, { userId: teacherUserId }).expect(200)).body.account).toMatchObject({ fullName: 'Grace Akinola', role: 'TEACHER' });
    expect((await as(teacherToken).get('/my/staff-record').expect(200)).body.staffNumber).toBe('OSN-ST-000001');
    expect(headB).toHaveLength(1);
  });

  it('keeps each school and LGA to its own staff', async () => {
    expect((await schoolA.get('/staff').expect(200)).body.map((s: { fullName: string }) => s.fullName)).toEqual(['Akinola Grace', 'Ojo Bayo']);
    expect((await schoolA.get('/staff?category=NON_TEACHING').expect(200)).body).toHaveLength(1);
    expect((await schoolA.get('/staff?q=trcn/123').expect(200)).body).toHaveLength(1);
    await schoolB.get(`/staff/${grace}`).expect(404);
    await officerB.get(`/staff/${grace}`).expect(404);
    expect((await officerB.get('/staff').expect(200)).body).toHaveLength(1);
    await officerB.patch(`/staff/${grace}`, { rank: 'Principal' }).expect(403);
    expect((await ministry.get('/staff').expect(200)).body).toHaveLength(3);
    const stats = (await schoolA.get('/stats').expect(200)).body;
    expect(stats.staff).toEqual({ teaching: 1, nonTeaching: 1 });
  });

  it('moves staff to another school when the Ministry approves a transfer, taking the account with them', async () => {
    await schoolB.post('/staff-transfers', { staffId: grace, toSchoolId: aId, reason: 'Not ours to move' }).expect(404);
    const r = await schoolA.post('/staff-transfers', { staffId: grace, toSchoolId: bId, reason: 'Spouse relocated to Ejigbo' }).expect(201);
    await schoolA.post('/staff-transfers', { staffId: grace, toSchoolId: bId, reason: 'Again' }).expect(409);
    expect((await officerB.get('/staff-transfers').expect(200)).body).toHaveLength(1);
    expect((await ministry.get('/stats').expect(200)).body.pendingStaffTransfers).toBe(1);
    await schoolA.post(`/staff-transfers/${r.body.id}/approve`, {}).expect(403);
    const done = await ministry.post(`/staff-transfers/${r.body.id}/approve`, { note: 'Approved' }).expect(201);
    expect(done.body).toMatchObject({ status: 'APPROVED', from: { id: aId }, to: { id: bId } });

    const rec = (await schoolB.get(`/staff/${grace}`).expect(200)).body;
    expect(rec.school.id).toBe(bId);
    expect(rec.postings.map((p: { school: { id: string }; endDate: string | null }) => [p.school.id, p.endDate === null])).toEqual([[bId, true], [aId, false]]);
    await schoolA.get(`/staff/${grace}`).expect(404);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: teacherUserId } });
    expect(user.schoolId).toBe(bId);
    expect((await prisma.classArm.findUniqueOrThrow({ where: { id: clsA } })).classTeacherId).toBeNull();
    expect(await prisma.refreshToken.count({ where: { userId: teacherUserId, revokedAt: null } })).toBe(0);
  });

  it('lets the Ministry post directly, and ends the posting when someone retires', async () => {
    const tunde = (await ministry.get('/staff?q=Tunde').expect(200)).body[0].id;
    await schoolB.post(`/staff/${tunde}/postings`, { schoolId: aId }).expect(403);
    const moved = await ministry.post(`/staff/${tunde}/postings`, { schoolId: aId, reason: 'Staffing need' }).expect(201);
    expect(moved.body.school.id).toBe(aId);
    await ministry.post(`/staff/${tunde}/postings`, { schoolId: aId }).expect(400);
    const retired = await schoolA.patch(`/staff/${tunde}`, { status: 'RETIRED' }).expect(200);
    expect(retired.body.school).toBeNull();
    expect(retired.body.postings.every((p: { endDate: string | null }) => p.endDate)).toBe(true);
    expect((await ministry.get('/staff?status=RETIRED').expect(200)).body).toHaveLength(1);
    expect((await ministry.get(`/staff/${tunde}`).expect(200)).body.status).toBe('RETIRED');
  });
});
