import { ForbiddenException, Injectable } from '@nestjs/common';
import { ClassLevel, Prisma, Role, SssGrading } from '@prisma/client';
import { AuthUser } from '../common/auth-user';
import { className, LEVEL_ORDER } from '../common/classes';
import { gradeFor, PASS_MARK, round1, subjectName, termName } from '../common/results';
import { isOversight } from '../common/scope';
import { GradingService } from '../grading/grading.service';
import { PrismaService } from '../prisma/prisma.service';

export interface RecordsQuery {
  q?: string;
  sessionId?: string;
  term?: number;
  schoolId?: string;
  level?: ClassLevel;
  classId?: string;
  subject?: string;
  page?: number;
}

/** Rows per page on screen; a CSV download can hold up to EXPORT_LIMIT. */
export const PAGE_SIZE = 100;
export const EXPORT_LIMIT = 50_000;

interface Row {
  id: string;
  total: number;
  session: string;
  term: number;
  sssGrading: SssGrading;
  schoolId: string;
  school: string;
  schoolCode: string;
  level: ClassLevel;
  arm: string;
  studentId: string;
  surname: string;
  firstName: string;
  middleName: string | null;
  learnerId: string;
  subjectCode: string;
  final: boolean;
  admissionNumber: string | null;
}

/**
 * Examination records: every approved subject score, searchable across sessions, terms, schools, classes, subjects
 * and students. Oversight users see released results in their area. A school sees its own approved scores (marked
 * provisional until released) and the released records its current students brought from earlier schools, so a
 * student's record follows them.
 */
@Injectable()
export class RecordsService {
  constructor(private readonly prisma: PrismaService, private readonly grading: GradingService) {}

  private where(actor: AuthUser, q: RecordsQuery) {
    const parts: Prisma.Sql[] = [Prisma.sql`sh.status = 'APPROVED'`, Prisma.sql`s.total IS NOT NULL`];
    if (isOversight(actor)) {
      parts.push(Prisma.sql`cr.id IS NOT NULL`);
      if (actor.lga) parts.push(Prisma.sql`sc.lga = ${actor.lga}`);
    } else if (actor.role === Role.SCHOOL_ADMIN) {
      parts.push(Prisma.sql`(sc.id = ${actor.schoolId}::uuid OR (st."currentSchoolId" = ${actor.schoolId}::uuid AND cr.id IS NOT NULL))`);
    } else {
      throw new ForbiddenException('You do not have access to this.');
    }
    if (q.sessionId) parts.push(Prisma.sql`t."sessionId" = ${q.sessionId}::uuid`);
    if (q.term) parts.push(Prisma.sql`t.number = ${q.term}`);
    if (q.schoolId) parts.push(Prisma.sql`sc.id = ${q.schoolId}::uuid`);
    if (q.level) parts.push(Prisma.sql`ca.level = ${q.level}::"ClassLevel"`);
    if (q.classId) parts.push(Prisma.sql`ca.id = ${q.classId}::uuid`);
    if (q.subject) parts.push(Prisma.sql`cs."subjectCode" = ${q.subject}`);
    for (const w of (q.q ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 5)) {
      const like = `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      parts.push(Prisma.sql`(st.surname ILIKE ${like} OR st."firstName" ILIKE ${like} OR st."middleName" ILIKE ${like} OR st."learnerId" ILIKE ${like}
        OR EXISTS (SELECT 1 FROM "Enrolment" e WHERE e."studentId" = st.id AND e."admissionNumber" ILIKE ${like}))`);
    }
    return Prisma.join(parts, ' AND ');
  }

  private readonly from = Prisma.sql`
    FROM "Score" s
    JOIN "ScoreSheet" sh ON sh.id = s."sheetId"
    JOIN "Term" t ON t.id = sh."termId"
    JOIN "AcademicSession" ses ON ses.id = t."sessionId"
    JOIN "ClassSubject" cs ON cs.id = sh."classSubjectId"
    JOIN "ClassArm" ca ON ca.id = cs."classArmId"
    JOIN "School" sc ON sc.id = ca."schoolId"
    JOIN "Student" st ON st.id = s."studentId"
    LEFT JOIN "ClassResult" cr ON cr."classArmId" = ca.id AND cr."termId" = sh."termId"`;

  private async rows(actor: AuthUser, q: RecordsQuery, limit: number, offset: number) {
    return this.prisma.$queryRaw<Row[]>`
      SELECT s.id, s.total, ses.name AS session, t.number AS term, t."sssGrading", sc.id AS "schoolId", sc.name AS school, sc.code AS "schoolCode",
        ca.level, ca.arm, st.id AS "studentId", st.surname, st."firstName", st."middleName", st."learnerId", cs."subjectCode",
        (cr.id IS NOT NULL) AS final,
        (SELECT e."admissionNumber" FROM "Enrolment" e WHERE e."studentId" = st.id AND e."schoolId" = sc.id ORDER BY e."admittedOn" DESC LIMIT 1) AS "admissionNumber"
      ${this.from}
      WHERE ${this.where(actor, q)}
      ORDER BY ses."startDate" DESC, t.number DESC, sc.name, ca.level, ca.arm, st.surname, st."firstName", cs."subjectCode"
      LIMIT ${limit} OFFSET ${offset}`;
  }

  private view(r: Row) {
    return {
      id: r.id, session: r.session, term: termName(r.term), school: { id: r.schoolId, name: r.school, code: r.schoolCode },
      class: className(r.level, r.arm), studentId: r.studentId, student: [r.surname, r.firstName, r.middleName].filter(Boolean).join(' '),
      learnerId: r.learnerId, admissionNumber: r.admissionNumber, subjectCode: r.subjectCode, subject: subjectName(r.subjectCode),
      score: r.total, grade: gradeFor(r.level, r.total, r.sssGrading)?.grade ?? null, status: r.final ? 'FINAL' : 'PROVISIONAL',
    };
  }

  async search(actor: AuthUser, q: RecordsQuery) {
    await this.grading.refresh();
    const page = Math.max(1, q.page ?? 1);
    const [stats] = await this.prisma.$queryRaw<{ records: bigint; mean: number | null; passes: bigint; students: bigint }[]>`
      SELECT count(*) AS records, avg(s.total)::float AS mean, count(*) FILTER (WHERE s.total >= ${PASS_MARK}) AS passes, count(DISTINCT s."studentId") AS students
      ${this.from}
      WHERE ${this.where(actor, q)}`;
    const rows = await this.rows(actor, q, PAGE_SIZE, (page - 1) * PAGE_SIZE);
    const records = Number(stats.records);
    return {
      summary: {
        records, students: Number(stats.students),
        mean: stats.mean === null ? null : round1(stats.mean),
        passRate: records ? round1((Number(stats.passes) / records) * 100) : null,
        passMark: PASS_MARK,
      },
      page, pages: Math.max(1, Math.ceil(records / PAGE_SIZE)), pageSize: PAGE_SIZE,
      rows: rows.map((r) => this.view(r)),
    };
  }

  async csv(actor: AuthUser, q: RecordsQuery) {
    await this.grading.refresh();
    const rows = (await this.rows(actor, q, EXPORT_LIMIT, 0)).map((r) => this.view(r));
    return [
      ['Session', 'Term', 'School', 'School no.', 'Class', 'Learner ID', 'Adm. no.', 'Student', 'Subject', 'Score', 'Grade', 'Record'],
      ...rows.map((r) => [r.session, r.term, r.school.name, r.school.code, r.class, r.learnerId, r.admissionNumber, r.student, r.subject, r.score, r.grade, r.status === 'FINAL' ? 'Final' : 'Provisional']),
    ];
  }

  /** What the filters offer: sessions, the subjects and class levels that have records, and the schools in view. */
  async options(actor: AuthUser) {
    if (!isOversight(actor) && actor.role !== Role.SCHOOL_ADMIN) throw new ForbiddenException('You do not have access to this.');
    const [sessions, subjects, levels] = await Promise.all([
      this.prisma.academicSession.findMany({ orderBy: { startDate: 'desc' }, select: { id: true, name: true } }),
      this.prisma.classSubject.findMany({ distinct: ['subjectCode'], select: { subjectCode: true } }),
      this.prisma.classArm.findMany({ distinct: ['level'], select: { level: true }, where: actor.role === Role.SCHOOL_ADMIN ? { schoolId: actor.schoolId! } : undefined }),
    ]);
    const schools = isOversight(actor)
      ? await this.prisma.school.findMany({ where: actor.lga ? { lga: actor.lga } : {}, select: { id: true, name: true, lga: true }, orderBy: [{ lga: 'asc' }, { name: 'asc' }] })
      : await this.prisma.school.findMany({ where: { id: actor.schoolId! }, select: { id: true, name: true, lga: true } });
    return {
      sessions,
      subjects: subjects.map((s) => ({ code: s.subjectCode, name: subjectName(s.subjectCode) })).sort((a, b) => a.name.localeCompare(b.name)),
      levels: levels.map((l) => l.level).sort((a, b) => LEVEL_ORDER.indexOf(a) - LEVEL_ORDER.indexOf(b)),
      schools,
    };
  }
}
