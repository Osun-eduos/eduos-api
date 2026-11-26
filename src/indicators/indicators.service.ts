import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthUser } from '../common/auth-user';
import { isoDate, today } from '../common/dates';
import { CREDIT_MARK, PASS_MARK, termName } from '../common/results';
import { isOversight } from '../common/scope';
import { PrismaService } from '../prisma/prisma.service';

/** Qualifications that count as a teaching qualification (the national minimum is the NCE). */
export const TEACHING_QUALIFICATIONS = ['NCE', 'B.Ed', 'B.A.(Ed)', 'B.Sc.(Ed)', 'PGDE', 'M.Ed'];

/** Plain-language definitions, shown on the dashboard and printed in every export. */
export const DEFINITIONS: { key: string; name: string; meaning: string }[] = [
  { key: 'students', name: 'Students enrolled', meaning: 'Students placed in a class in the session.' },
  { key: 'gpi', name: 'Gender parity index', meaning: 'Girls enrolled divided by boys enrolled. 1.00 is parity; below 0.97 favours boys, above 1.03 favours girls.' },
  { key: 'teachers', name: 'Teachers', meaning: 'Teaching staff in the registry posted to the school on the reference date (today, or the last day of a past session).' },
  { key: 'pupilsPerTeacher', name: 'Pupils per teacher', meaning: 'Students enrolled divided by teachers. The national benchmark is 35 for basic education and 40 for senior secondary.' },
  { key: 'qualifiedTeachers', name: 'Qualified teachers', meaning: `Share of teachers with a teaching qualification (${TEACHING_QUALIFICATIONS.join(', ')}).` },
  { key: 'trcnTeachers', name: 'TRCN-registered teachers', meaning: 'Share of teachers with a Teachers Registration Council number recorded.' },
  { key: 'attendanceRate', name: 'Attendance rate', meaning: 'Present and late marks as a share of all register marks.' },
  { key: 'average', name: 'Average score', meaning: 'Mean subject total (out of 100) in released results.' },
  { key: 'passRate', name: 'Pass rate', meaning: `Share of subject results of ${PASS_MARK} or more, in released results.` },
  { key: 'creditRate', name: 'Credit rate', meaning: `Share of subject results of ${CREDIT_MARK} or more, in released results.` },
  { key: 'inspected', name: 'Schools inspected', meaning: 'Schools with at least one inspection visit during the session; the condition is from the latest visit.' },
];

const STAGE = (level: string) => (level.startsWith('PRIMARY') ? 'primary' : level.startsWith('JSS') ? 'jss' : 'sss');

/** Counts gathered per school; ratios are worked out after adding schools together. */
interface Counts {
  schools: number;
  classes: number;
  girls: number;
  boys: number;
  primary: number;
  jss: number;
  sss: number;
  teachers: number;
  nonTeaching: number;
  qualified: number;
  trcn: number;
  present: number;
  late: number;
  absent: number;
  excused: number;
  entries: number;
  totalScore: number;
  passes: number;
  credits: number;
  girlsEntries: number;
  girlsPasses: number;
  boysEntries: number;
  boysPasses: number;
  inspected: number;
  good: number;
  fair: number;
  poor: number;
  critical: number;
}
const zero = (): Counts => ({
  schools: 0, classes: 0, girls: 0, boys: 0, primary: 0, jss: 0, sss: 0, teachers: 0, nonTeaching: 0, qualified: 0, trcn: 0,
  present: 0, late: 0, absent: 0, excused: 0, entries: 0, totalScore: 0, passes: 0, credits: 0,
  girlsEntries: 0, girlsPasses: 0, boysEntries: 0, boysPasses: 0, inspected: 0, good: 0, fair: 0, poor: 0, critical: 0,
});
const add = (a: Counts, b: Counts) => {
  for (const k of Object.keys(a) as (keyof Counts)[]) a[k] += b[k];
  return a;
};

const r1 = (n: number) => Math.round(n * 10) / 10;
const pct = (part: number, whole: number) => (whole ? r1((part / whole) * 100) : null);

/** The published figures for a set of schools. */
export function figures(c: Counts) {
  const students = c.girls + c.boys;
  const marks = c.present + c.late + c.absent + c.excused;
  return {
    schools: c.schools,
    classes: c.classes,
    students,
    girls: c.girls,
    boys: c.boys,
    girlsShare: pct(c.girls, students),
    gpi: c.boys ? Math.round((c.girls / c.boys) * 100) / 100 : null,
    byStage: { primary: c.primary, jss: c.jss, sss: c.sss },
    averageClassSize: c.classes ? r1(students / c.classes) : null,
    teachers: c.teachers,
    nonTeachingStaff: c.nonTeaching,
    pupilsPerTeacher: c.teachers ? r1(students / c.teachers) : null,
    qualifiedTeachers: pct(c.qualified, c.teachers),
    trcnTeachers: pct(c.trcn, c.teachers),
    attendanceRate: pct(c.present + c.late, marks),
    registerMarks: marks,
    resultEntries: c.entries,
    average: c.entries ? r1(c.totalScore / c.entries) : null,
    passRate: pct(c.passes, c.entries),
    creditRate: pct(c.credits, c.entries),
    passRateGirls: pct(c.girlsPasses, c.girlsEntries),
    passRateBoys: pct(c.boysPasses, c.boysEntries),
    inspected: c.inspected,
    condition: { good: c.good, fair: c.fair, poor: c.poor, critical: c.critical },
  };
}
export type Figures = ReturnType<typeof figures>;

@Injectable()
export class IndicatorsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The area the actor may look at: an LGA officer or LGA inspector is held to their LGA. */
  private area(actor: AuthUser, lga?: string) {
    if (!isOversight(actor)) throw new ForbiddenException('You do not have access to this.');
    if (actor.lga) {
      if (lga && lga !== actor.lga) throw new NotFoundException('LGA not found.');
      return actor.lga;
    }
    return lga || null;
  }

  private async session(sessionId?: string) {
    const s = sessionId
      ? await this.prisma.academicSession.findUnique({ where: { id: sessionId }, include: { terms: { orderBy: { number: 'asc' } } } })
      : await this.prisma.academicSession.findFirst({ where: { isCurrent: true }, include: { terms: { orderBy: { number: 'asc' } } } });
    if (!s) throw new NotFoundException(sessionId ? 'Session not found.' : 'No academic session is open yet.');
    return s;
  }

  /** Counts for every school in the area for one session (and optionally one term). */
  private async perSchool(session: { id: string; startDate: Date; endDate: Date; terms: { id: string; number: number; startDate: Date; endDate: Date }[] }, lga: string | null, termId?: string) {
    const term = termId ? session.terms.find((t) => t.id === termId) : undefined;
    if (termId && !term) throw new BadRequestException('That term is not in the session.');
    const terms = term ? [term.id] : session.terms.map((t) => t.id);
    const from = term?.startDate ?? session.startDate;
    const to = term?.endDate ?? session.endDate;
    // Staff are counted as posted on this date: today for the current session, or its last day for a past one.
    const asOf = session.endDate < today() ? session.endDate : today();
    const lgaSql = lga ? Prisma.sql`AND sc.lga = ${lga}` : Prisma.empty;
    const termList = terms.length ? Prisma.join(terms) : Prisma.sql`NULL`;

    const schools = await this.prisma.$queryRaw<{ id: string; name: string; code: string; lga: string }[]>`
      SELECT sc.id, sc.name, sc.code, sc.lga FROM "School" sc WHERE sc."isActive" ${lgaSql} ORDER BY sc.lga, sc.name`;
    const [enrol, classes, staff, marks, results, inspections] = await Promise.all([
      this.prisma.$queryRaw<{ schoolId: string; sex: string; level: string; n: bigint }[]>`
        SELECT ca."schoolId", st.sex::text AS sex, ca.level::text AS level, count(*) AS n
        FROM "ClassPlacement" cp JOIN "ClassArm" ca ON ca.id = cp."classArmId" JOIN "Student" st ON st.id = cp."studentId" JOIN "School" sc ON sc.id = ca."schoolId"
        WHERE cp."sessionId" = ${session.id}::uuid ${lgaSql} GROUP BY 1, 2, 3`,
      this.prisma.$queryRaw<{ schoolId: string; n: bigint }[]>`
        SELECT ca."schoolId", count(*) AS n FROM "ClassArm" ca JOIN "School" sc ON sc.id = ca."schoolId"
        WHERE ca."sessionId" = ${session.id}::uuid ${lgaSql} GROUP BY 1`,
      this.prisma.$queryRaw<{ schoolId: string; category: string; n: bigint; qualified: bigint; trcn: bigint }[]>`
        SELECT p."schoolId", st.category::text AS category, count(DISTINCT st.id) AS n,
          count(DISTINCT st.id) FILTER (WHERE EXISTS (SELECT 1 FROM "Qualification" q WHERE q."staffId" = st.id AND q.kind IN (${Prisma.join(TEACHING_QUALIFICATIONS)}))) AS qualified,
          count(DISTINCT st.id) FILTER (WHERE st."trcnNumber" IS NOT NULL AND st."trcnNumber" <> '') AS trcn
        FROM "Posting" p JOIN "Staff" st ON st.id = p."staffId" JOIN "School" sc ON sc.id = p."schoolId"
        WHERE p."startDate" <= ${asOf}::date AND (p."endDate" IS NULL OR p."endDate" > ${asOf}::date) ${lgaSql} GROUP BY 1, 2`,
      this.prisma.$queryRaw<{ schoolId: string; status: string; n: bigint }[]>`
        SELECT ca."schoolId", m.status::text AS status, count(*) AS n
        FROM "AttendanceMark" m JOIN "AttendanceRegister" r ON r.id = m."registerId" JOIN "ClassArm" ca ON ca.id = r."classArmId" JOIN "School" sc ON sc.id = ca."schoolId"
        WHERE ca."sessionId" = ${session.id}::uuid AND r.date BETWEEN ${from}::date AND ${to}::date ${lgaSql} GROUP BY 1, 2`,
      this.prisma.$queryRaw<{ schoolId: string; sex: string; n: bigint; total: number | null; passes: bigint; credits: bigint }[]>`
        SELECT ca."schoolId", stu.sex::text AS sex, count(*) AS n, sum(s.total)::float AS total,
          count(*) FILTER (WHERE s.total >= ${PASS_MARK}) AS passes, count(*) FILTER (WHERE s.total >= ${CREDIT_MARK}) AS credits
        FROM "Score" s JOIN "ScoreSheet" sh ON sh.id = s."sheetId" JOIN "ClassSubject" cs ON cs.id = sh."classSubjectId"
          JOIN "ClassArm" ca ON ca.id = cs."classArmId" JOIN "ClassResult" cr ON cr."classArmId" = ca.id AND cr."termId" = sh."termId"
          JOIN "Student" stu ON stu.id = s."studentId" JOIN "School" sc ON sc.id = ca."schoolId"
        WHERE sh.status = 'APPROVED' AND s.total IS NOT NULL AND sh."termId"::text IN (${termList}) ${lgaSql} GROUP BY 1, 2`,
      this.prisma.$queryRaw<{ schoolId: string; overall: string }[]>`
        SELECT DISTINCT ON (i."schoolId") i."schoolId", i.overall FROM "Inspection" i JOIN "School" sc ON sc.id = i."schoolId"
        WHERE i."visitedOn" BETWEEN ${session.startDate}::date AND ${session.endDate}::date ${lgaSql}
        ORDER BY i."schoolId", i."visitedOn" DESC, i."createdAt" DESC`,
    ]);

    const by = new Map(schools.map((s) => [s.id, { school: s, c: { ...zero(), schools: 1 } }]));
    const get = (id: string) => by.get(id)?.c;
    for (const e of enrol) {
      const c = get(e.schoolId);
      if (!c) continue;
      const n = Number(e.n);
      if (e.sex === 'F') c.girls += n;
      else c.boys += n;
      c[STAGE(e.level)] += n;
    }
    for (const x of classes) {
      const c = get(x.schoolId);
      if (c) c.classes = Number(x.n);
    }
    for (const x of staff) {
      const c = get(x.schoolId);
      if (!c) continue;
      if (x.category === 'TEACHING') {
        c.teachers += Number(x.n);
        c.qualified += Number(x.qualified);
        c.trcn += Number(x.trcn);
      } else c.nonTeaching += Number(x.n);
    }
    for (const x of marks) {
      const c = get(x.schoolId);
      if (c) c[x.status.toLowerCase() as 'present' | 'late' | 'absent' | 'excused'] += Number(x.n);
    }
    for (const x of results) {
      const c = get(x.schoolId);
      if (!c) continue;
      const n = Number(x.n), passes = Number(x.passes);
      c.entries += n;
      c.totalScore += x.total ?? 0;
      c.passes += passes;
      c.credits += Number(x.credits);
      if (x.sex === 'F') {
        c.girlsEntries += n;
        c.girlsPasses += passes;
      } else {
        c.boysEntries += n;
        c.boysPasses += passes;
      }
    }
    for (const x of inspections) {
      const c = get(x.schoolId);
      if (!c) continue;
      c.inspected = 1;
      c[x.overall.toLowerCase() as 'good' | 'fair' | 'poor' | 'critical'] += 1;
    }
    return { rows: [...by.values()], term, asOf };
  }

  async indicators(actor: AuthUser, q: { sessionId?: string; termId?: string; lga?: string }) {
    const lga = this.area(actor, q.lga);
    const session = await this.session(q.sessionId);
    const { rows, term, asOf } = await this.perSchool(session, lga, q.termId);
    const total = rows.reduce((t, r) => add(t, r.c), zero());

    // State view: one row per LGA. LGA view: one row per school.
    let breakdown: { key: string; name: string; lga: string; code?: string; figures: Figures }[];
    if (lga) {
      breakdown = rows.map((r) => ({ key: r.school.id, name: r.school.name, code: r.school.code, lga: r.school.lga, figures: figures(r.c) }));
    } else {
      const lgas = new Map<string, Counts>();
      for (const r of rows) add(lgas.get(r.school.lga) ?? lgas.set(r.school.lga, zero()).get(r.school.lga)!, r.c);
      breakdown = [...lgas.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, c]) => ({ key: name, name, lga: name, figures: figures(c) }));
    }

    return {
      scope: { lga, level: lga ? 'lga' : 'state', label: lga ? `${lga} LGA` : 'Osun State' },
      session: { id: session.id, name: session.name, isCurrent: session.isCurrent },
      term: term ? { id: term.id, name: termName(term.number) } : null,
      terms: session.terms.map((t) => ({ id: t.id, name: termName(t.number) })),
      staffAsOf: isoDate(asOf),
      totals: figures(total),
      breakdown,
      generatedAt: new Date().toISOString(),
    };
  }

  /** How the area's main indicators moved across sessions, and attendance month by month in the chosen session. */
  async trends(actor: AuthUser, q: { sessionId?: string; lga?: string }) {
    const lga = this.area(actor, q.lga);
    const chosen = await this.session(q.sessionId);
    const sessions = await this.prisma.academicSession.findMany({ where: { startDate: { lte: chosen.startDate } }, include: { terms: true }, orderBy: { startDate: 'asc' } });
    const bySession = [];
    for (const s of sessions.slice(-6)) {
      const { rows } = await this.perSchool(s, lga);
      const f = figures(rows.reduce((t, r) => add(t, r.c), zero()));
      bySession.push({ session: s.name, students: f.students, girlsShare: f.girlsShare, gpi: f.gpi, pupilsPerTeacher: f.pupilsPerTeacher, attendanceRate: f.attendanceRate, passRate: f.passRate });
    }
    const lgaSql = lga ? Prisma.sql`AND sc.lga = ${lga}` : Prisma.empty;
    const months = await this.prisma.$queryRaw<{ month: Date; present: bigint; marks: bigint }[]>`
      SELECT date_trunc('month', r.date)::date AS month, count(*) FILTER (WHERE m.status IN ('PRESENT', 'LATE')) AS present, count(*) AS marks
      FROM "AttendanceMark" m JOIN "AttendanceRegister" r ON r.id = m."registerId" JOIN "ClassArm" ca ON ca.id = r."classArmId" JOIN "School" sc ON sc.id = ca."schoolId"
      WHERE ca."sessionId" = ${chosen.id}::uuid ${lgaSql} GROUP BY 1 ORDER BY 1`;
    return {
      bySession,
      attendanceByMonth: months.map((m) => ({ month: isoDate(m.month)!.slice(0, 7), attendanceRate: pct(Number(m.present), Number(m.marks)), marks: Number(m.marks) })),
    };
  }
}
