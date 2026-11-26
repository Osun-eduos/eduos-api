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
  { key: 'pupilsPerClassroom', name: 'Pupils per classroom', meaning: 'Students enrolled divided by classrooms safe to use at the latest inspection (or the classrooms the school declared, if never inspected). The benchmark is 40.' },
  { key: 'ger', name: 'Gross enrolment ratio (GER)', meaning: 'Students enrolled in a stage, of any age, as a share of the population of the official age for that stage (primary 6 to 11, JSS 12 to 14, SSS 15 to 17). Can exceed 100%. Needs the Ministry’s population estimates, and counts only schools on EduOS.' },
  { key: 'ner', name: 'Net enrolment ratio (NER)', meaning: 'Students of the official age enrolled in that stage, as a share of the population of that age.' },
  { key: 'outOfSchool', name: 'Out-of-school children (estimate)', meaning: 'Population aged 6 to 17 minus students of those ages enrolled in any EduOS school. Children in schools not yet on EduOS are counted as out of school, so treat this as an upper bound.' },
  { key: 'transition', name: 'Transition rate', meaning: 'Students in Primary 6 (or JSS 3) last session who are in JSS 1 (or SSS 1) this session, anywhere in the state.' },
  { key: 'completion', name: 'Completion (proxy)', meaning: 'Students enrolled in the last class of a stage (Primary 6, JSS 3, SSS 3) as a share of one year’s population at that age.' },
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
  rooms: number;
  roomStudents: number;
  good: number;
  fair: number;
  poor: number;
  critical: number;
}
const zero = (): Counts => ({
  schools: 0, classes: 0, girls: 0, boys: 0, primary: 0, jss: 0, sss: 0, teachers: 0, nonTeaching: 0, qualified: 0, trcn: 0,
  present: 0, late: 0, absent: 0, excused: 0, entries: 0, totalScore: 0, passes: 0, credits: 0,
  girlsEntries: 0, girlsPasses: 0, boysEntries: 0, boysPasses: 0, inspected: 0, rooms: 0, roomStudents: 0, good: 0, fair: 0, poor: 0, critical: 0,
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
    classrooms: c.rooms,
    pupilsPerClassroom: c.rooms ? r1(c.roomStudents / c.rooms) : null,
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
    const [enrol, classes, staff, marks, results, inspections, rooms] = await Promise.all([
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
      this.prisma.$queryRaw<{ schoolId: string; rooms: number | null }[]>`
        SELECT sc.id AS "schoolId", coalesce((
          SELECT (i.answers->'classrooms'->>'usable')::int FROM "Inspection" i
          WHERE i."schoolId" = sc.id AND i."visitedOn" <= ${session.endDate}::date ORDER BY i."visitedOn" DESC, i."createdAt" DESC LIMIT 1
        ), sc.classrooms) AS rooms
        FROM "School" sc WHERE sc."isActive" ${lgaSql}`,
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
    for (const x of rooms) {
      const c = get(x.schoolId);
      if (!c || x.rooms === null) continue;
      c.rooms = x.rooms;
      c.roomStudents = c.girls + c.boys;
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

  // ---------- Access: population, GER, NER, out of school, transition ----------

  async population(actor: AuthUser, year?: number) {
    this.area(actor);
    const y = year ?? (await this.session()).startDate.getUTCFullYear();
    const rows = await this.prisma.populationEstimate.findMany({ where: { year: y }, orderBy: [{ lga: 'asc' }, { stage: 'asc' }] });
    const years = await this.prisma.populationEstimate.groupBy({ by: ['year'], orderBy: { year: 'desc' } });
    return { year: y, years: years.map((x) => x.year), stages: STAGES, rows: rows.map((r) => ({ lga: r.lga, stage: r.stage, male: r.male, female: r.female, source: r.source })) };
  }

  async savePopulation(actor: AuthUser, year: number, rows: { lga: string; stage: string; male: number; female: number; source?: string }[]) {
    if (actor.role !== 'MINISTRY_ADMIN') throw new ForbiddenException('Only the Ministry administrator can change population estimates.');
    const seen = new Set<string>();
    for (const r of rows) {
      const k = `${r.lga}|${r.stage}`;
      if (seen.has(k)) throw new BadRequestException(`${r.lga} ${r.stage} is listed twice.`);
      seen.add(k);
    }
    await this.prisma.$transaction(async (tx) => {
      for (const r of rows) {
        await tx.populationEstimate.upsert({
          where: { lga_year_stage: { lga: r.lga, year, stage: r.stage } },
          create: { lga: r.lga, year, stage: r.stage, male: r.male, female: r.female, source: r.source ?? null },
          update: { male: r.male, female: r.female, source: r.source ?? null },
        });
      }
    });
    return this.population(actor, year);
  }

  /**
   * Enrolment against the school-age population, per LGA and for the area. Population figures are the latest the
   * Ministry has entered for a year up to the session's start.
   */
  async access(actor: AuthUser, q: { sessionId?: string; lga?: string }) {
    const lga = this.area(actor, q.lga);
    const session = await this.session(q.sessionId);
    const year = session.startDate.getUTCFullYear();
    const popYear = (await this.prisma.populationEstimate.findFirst({ where: { year: { lte: year } }, orderBy: { year: 'desc' }, select: { year: true } }))?.year ?? null;
    const lgaSql = lga ? Prisma.sql`AND sc.lga = ${lga}` : Prisma.empty;
    const ref = session.startDate;
    const enrol = await this.prisma.$queryRaw<{ lga: string; stage: string; official: boolean; school_age: boolean; n: bigint }[]>`
      SELECT sc.lga,
        CASE WHEN ca.level::text LIKE 'PRIMARY%' THEN 'PRIMARY' WHEN ca.level::text LIKE 'JSS%' THEN 'JSS' ELSE 'SSS' END AS stage,
        CASE WHEN ca.level::text LIKE 'PRIMARY%' THEN a.age BETWEEN 6 AND 11 WHEN ca.level::text LIKE 'JSS%' THEN a.age BETWEEN 12 AND 14 ELSE a.age BETWEEN 15 AND 17 END AS official,
        a.age BETWEEN 6 AND 17 AS school_age,
        count(*) AS n
      FROM "ClassPlacement" cp JOIN "ClassArm" ca ON ca.id = cp."classArmId" JOIN "School" sc ON sc.id = ca."schoolId" JOIN "Student" st ON st.id = cp."studentId"
        CROSS JOIN LATERAL (SELECT date_part('year', age(${ref}::date, st."dateOfBirth"))::int AS age) a
      WHERE cp."sessionId" = ${session.id}::uuid ${lgaSql}
      GROUP BY 1, 2, 3, 4`;
    const pop = popYear ? await this.prisma.populationEstimate.findMany({ where: { year: popYear, ...(lga ? { lga } : {}) } }) : [];
    const last = await this.prisma.academicSession.findFirst({ where: { startDate: { lt: session.startDate } }, orderBy: { startDate: 'desc' } });
    const finals = await this.prisma.$queryRaw<{ lga: string; level: string; n: bigint }[]>`
      SELECT sc.lga, ca.level::text AS level, count(*) AS n
      FROM "ClassPlacement" cp JOIN "ClassArm" ca ON ca.id = cp."classArmId" JOIN "School" sc ON sc.id = ca."schoolId"
      WHERE cp."sessionId" = ${session.id}::uuid AND ca.level IN ('PRIMARY_6', 'JSS_3', 'SSS_3') ${lgaSql} GROUP BY 1, 2`;
    const moved = last
      ? await this.prisma.$queryRaw<{ lga: string; from: string; total: bigint; moved: bigint }[]>`
          SELECT sc.lga, ca.level::text AS "from", count(*) AS total,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM "ClassPlacement" np JOIN "ClassArm" na ON na.id = np."classArmId"
              WHERE np."studentId" = cp."studentId" AND np."sessionId" = ${session.id}::uuid
                AND na.level = (CASE WHEN ca.level = 'PRIMARY_6' THEN 'JSS_1' ELSE 'SSS_1' END)::"ClassLevel"
            )) AS moved
          FROM "ClassPlacement" cp JOIN "ClassArm" ca ON ca.id = cp."classArmId" JOIN "School" sc ON sc.id = ca."schoolId"
          WHERE cp."sessionId" = ${last.id}::uuid AND ca.level IN ('PRIMARY_6', 'JSS_3') ${lgaSql}
          GROUP BY 1, 2`
      : [];

    type Acc = { enrolled: Record<string, number>; official: Record<string, number>; schoolAge: number; pop: Record<string, { male: number; female: number }>; finals: Record<string, number>; trans: Record<string, { total: number; moved: number }> };
    const blank = (): Acc => ({ enrolled: {}, official: {}, schoolAge: 0, pop: {}, finals: {}, trans: {} });
    const by = new Map<string, Acc>();
    const total = blank();
    const into = (name: string) => [by.get(name) ?? by.set(name, blank()).get(name)!, total];
    for (const e of enrol) for (const a of into(e.lga)) {
      a.enrolled[e.stage] = (a.enrolled[e.stage] ?? 0) + Number(e.n);
      if (e.official) a.official[e.stage] = (a.official[e.stage] ?? 0) + Number(e.n);
      if (e.school_age) a.schoolAge += Number(e.n);
    }
    for (const p of pop) for (const a of into(p.lga)) {
      const x = a.pop[p.stage] ?? { male: 0, female: 0 };
      a.pop[p.stage] = { male: x.male + p.male, female: x.female + p.female };
    }
    for (const f of finals) for (const a of into(f.lga)) a.finals[f.level] = (a.finals[f.level] ?? 0) + Number(f.n);
    for (const m of moved) for (const a of into(m.lga)) {
      const x = a.trans[m.from] ?? { total: 0, moved: 0 };
      a.trans[m.from] = { total: x.total + Number(m.total), moved: x.moved + Number(m.moved) };
    }
    const out = (a: Acc) => {
      const stages = STAGES.map((st) => {
        const p = a.pop[st.key];
        const people = p ? p.male + p.female : null;
        const lastClass = st.key === 'PRIMARY' ? 'PRIMARY_6' : st.key === 'JSS' ? 'JSS_3' : 'SSS_3';
        return {
          stage: st.key, name: st.name, ages: st.ages, enrolled: a.enrolled[st.key] ?? 0, officialAge: a.official[st.key] ?? 0, population: people,
          ger: people ? pct(a.enrolled[st.key] ?? 0, people) : null,
          ner: people ? pct(a.official[st.key] ?? 0, people) : null,
          completion: people ? pct(a.finals[lastClass] ?? 0, people / st.years) : null,
        };
      });
      const people = STAGES.reduce((t, st) => t + (a.pop[st.key] ? a.pop[st.key].male + a.pop[st.key].female : 0), 0);
      const complete = STAGES.every((st) => a.pop[st.key]);
      const t = (k: string) => (a.trans[k]?.total ? pct(a.trans[k].moved, a.trans[k].total) : null);
      return {
        stages,
        population: complete ? people : null,
        outOfSchool: complete ? Math.max(0, people - a.schoolAge) : null,
        outOfSchoolRate: complete && people ? pct(Math.max(0, people - a.schoolAge), people) : null,
        transition: { primaryToJss: t('PRIMARY_6'), jssToSss: t('JSS_3') },
      };
    };
    return {
      scope: { lga, label: lga ? `${lga} LGA` : 'Osun State' },
      session: { id: session.id, name: session.name },
      populationYear: popYear,
      previousSession: last?.name ?? null,
      totals: out(total),
      byLga: lga ? [] : [...by.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([name, a]) => ({ lga: name, ...out(a) })),
    };
  }

  // ---------- Comparisons over terms, and the dashboard overview ----------

  /** The last six terms up to the chosen one (or the current term), oldest first. */
  private async lastTerms(termId?: string) {
    const all = await this.prisma.term.findMany({ include: { session: { include: { terms: { orderBy: { number: 'asc' } } } } }, orderBy: [{ startDate: 'asc' }] });
    const end = termId ? all.findIndex((t) => t.id === termId) : all.findIndex((t) => t.isCurrent);
    const upTo = end >= 0 ? end : all.filter((t) => t.startDate <= today()).length - 1;
    return all.slice(Math.max(0, upTo - 5), upTo + 1);
  }

  /** Attendance, average score and pass rate for up to three LGAs and the state, term by term. */
  async compare(actor: AuthUser, q: { lgas?: string; termId?: string }) {
    this.area(actor);
    let lgas = (q.lgas ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    if (actor.lga) lgas = [actor.lga];
    if (lgas.length > 3) throw new BadRequestException('Compare up to three LGAs.');
    const terms = await this.lastTerms(q.termId);
    const series = lgas.map((l) => ({ name: l, points: [] as { term: string; attendanceRate: number | null; average: number | null; passRate: number | null; students: number }[] }));
    const state = { name: actor.lga ? `${actor.lga} LGA` : 'Osun State', points: [] as (typeof series)[number]['points'] };
    for (const t of terms) {
      const { rows } = await this.perSchool(t.session, actor.lga ?? null, t.id);
      const label = `${termName(t.number).replace(' term', '')} ${t.session.name}`;
      const point = (c: Counts) => {
        const f = figures(c);
        return { term: label, attendanceRate: f.attendanceRate, average: f.average, passRate: f.passRate, students: f.students };
      };
      state.points.push(point(rows.reduce((a, r) => add(a, r.c), zero())));
      for (const sr of series) sr.points.push(point(rows.filter((r) => r.school.lga === sr.name).reduce((a, r) => add(a, r.c), zero())));
    }
    return { terms: terms.map((t) => ({ id: t.id, name: termName(t.number), session: t.session.name })), state, lgas: actor.lga ? [] : series };
  }

  /**
   * What the dashboard needs at a glance: the average-score trend over six terms, each LGA's status (on track,
   * watch, needs support) and the schools that most need support, with the reasons.
   */
  async overview(actor: AuthUser, q: { lga?: string }) {
    const lga = this.area(actor, q.lga);
    const session = await this.session();
    const { rows } = await this.perSchool(session, lga);
    const terms = await this.lastTerms();
    const trend = [];
    for (const t of terms) {
      const { rows: tr } = await this.perSchool(t.session, lga, t.id);
      const f = figures(tr.reduce((a, r) => add(a, r.c), zero()));
      trend.push({ termId: t.id, term: `${termName(t.number).replace(' term', '')} ${t.session.name}`, average: f.average, passRate: f.passRate, entries: f.resultEntries });
    }

    const flags = (f: Figures, school: boolean) => {
      const out: { level: 'watch' | 'support'; text: string }[] = [];
      const t = school ? SCHOOL_THRESHOLDS : LGA_THRESHOLDS;
      const chk = (v: number | null, watch: number, support: number, below: boolean, text: (v: number) => string) => {
        if (v === null) return;
        if (below ? v < support : v > support) out.push({ level: 'support', text: text(v) });
        else if (below ? v < watch : v > watch) out.push({ level: 'watch', text: text(v) });
      };
      chk(f.attendanceRate, t.attendance[0], t.attendance[1], true, (v) => `Attendance ${v}%`);
      chk(f.passRate, t.passRate[0], t.passRate[1], true, (v) => `Pass rate ${v}%`);
      chk(f.pupilsPerTeacher, t.pupilsPerTeacher[0], t.pupilsPerTeacher[1], false, (v) => `${v} pupils per teacher`);
      chk(f.pupilsPerClassroom, t.pupilsPerClassroom[0], t.pupilsPerClassroom[1], false, (v) => `${v} pupils per classroom`);
      if (school) {
        if (f.condition.critical) out.push({ level: 'support', text: 'Critical inspection' });
        else if (f.condition.poor) out.push({ level: 'watch', text: 'Poor inspection' });
      } else if (f.inspected) {
        const bad = pct(f.condition.critical, f.inspected) ?? 0;
        if (bad >= 20) out.push({ level: 'support', text: `${bad}% of inspected schools critical` });
        else if (bad >= 10) out.push({ level: 'watch', text: `${bad}% of inspected schools critical` });
      }
      return out;
    };
    const status = (fl: { level: string }[]) => (fl.some((x) => x.level === 'support') ? 'NEEDS_SUPPORT' : fl.length ? 'WATCH' : 'ON_TRACK');

    const lgaRows = lga
      ? []
      : [...rows.reduce((m, r) => m.set(r.school.lga, add(m.get(r.school.lga) ?? zero(), r.c)), new Map<string, Counts>()).entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, c]) => {
            const f = figures(c);
            const fl = flags(f, false);
            return { lga: name, status: status(fl), reasons: fl.map((x) => x.text), students: f.students, attendanceRate: f.attendanceRate, passRate: f.passRate, pupilsPerTeacher: f.pupilsPerTeacher };
          });
    const schools = rows
      .map((r) => {
        const f = figures(r.c);
        const fl = flags(f, true);
        return { id: r.school.id, name: r.school.name, code: r.school.code, lga: r.school.lga, status: status(fl), reasons: fl.map((x) => x.text), score: fl.reduce((t, x) => t + (x.level === 'support' ? 2 : 1), 0), students: f.students, attendanceRate: f.attendanceRate, passRate: f.passRate };
      })
      .filter((x) => x.status === 'NEEDS_SUPPORT')
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return {
      scope: { lga, label: lga ? `${lga} LGA` : 'Osun State' },
      session: { id: session.id, name: session.name },
      thresholds: { lga: LGA_THRESHOLDS, school: SCHOOL_THRESHOLDS },
      trend,
      lgas: lgaRows,
      lgaCounts: { ON_TRACK: lgaRows.filter((x) => x.status === 'ON_TRACK').length, WATCH: lgaRows.filter((x) => x.status === 'WATCH').length, NEEDS_SUPPORT: lgaRows.filter((x) => x.status === 'NEEDS_SUPPORT').length },
      schoolsNeedingSupport: schools.slice(0, 25).map(({ score: _s, ...x }) => x),
      schoolsNeedingSupportCount: schools.length,
    };
  }
}

export const STAGES = [
  { key: 'PRIMARY', name: 'Primary', ages: '6 to 11', years: 6 },
  { key: 'JSS', name: 'Junior secondary', ages: '12 to 14', years: 3 },
  { key: 'SSS', name: 'Senior secondary', ages: '15 to 17', years: 3 },
];

/** [watch, needs support]. Rates below these, or ratios above them, raise a flag. */
export const LGA_THRESHOLDS = { attendance: [90, 85], passRate: [75, 65], pupilsPerTeacher: [40, 50], pupilsPerClassroom: [45, 55] };
export const SCHOOL_THRESHOLDS = { attendance: [85, 75], passRate: [70, 55], pupilsPerTeacher: [45, 60], pupilsPerClassroom: [50, 65] };
