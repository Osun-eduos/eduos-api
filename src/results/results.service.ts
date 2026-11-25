import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ClassArm, Prisma, Role, SheetStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth-user';
import { className } from '../common/classes';
import { isoDate } from '../common/dates';
import { isOversight, schoolsInScope, seesLga } from '../common/scope';
import { Component, CREDIT_MARK, gradeFor, ordinal, PASS_MARK, rank, round1, scaleFor, subjectName, termName } from '../common/results';
import { currentTerm } from '../common/session';
import { PrismaService } from '../prisma/prisma.service';
import { StudentsService } from '../students/students.service';
import { Marks, SheetsService } from './sheets.service';

type TermRow = Prisma.TermGetPayload<{ include: { session: true } }>;
const fullName = (s: { surname: string; firstName: string; middleName: string | null }) => [s.surname, s.firstName, s.middleName].filter(Boolean).join(' ');
const avg = (xs: number[]) => (xs.length ? round1(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

@Injectable()
export class ResultsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sheets: SheetsService,
    private readonly students: StudentsService,
  ) {}

  private async term(termId?: string): Promise<TermRow> {
    const t = termId ? await this.prisma.term.findUnique({ where: { id: termId }, include: { session: true } }) : await currentTerm(this.prisma);
    if (!t) throw new BadRequestException(termId ? 'Term not found.' : 'The Ministry has not set the current term yet.');
    return t;
  }

  /** Every subject's totals for a class and term, with averages and positions. */
  private async compute(c: ClassArm, term: TermRow, approvedOnly: boolean) {
    const [subjects, roll] = await Promise.all([
      this.prisma.classSubject.findMany({
        where: { classArmId: c.id },
        include: {
          teacher: { select: { id: true, fullName: true } },
          sheets: { where: { termId: term.id }, include: { scores: true } },
        },
      }),
      this.sheets.roll(c.id, c.schoolId, term.endDate),
    ]);
    subjects.sort((a, b) => subjectName(a.subjectCode).localeCompare(subjectName(b.subjectCode)));
    const onRoll = new Set(roll.map((p) => p.studentId));
    const subjectRows = subjects.map((s) => {
      const sheet = s.sheets[0];
      const usable = sheet && (!approvedOnly || sheet.status === SheetStatus.APPROVED);
      const scores = new Map<string, { marks: Marks; total: number | null }>();
      if (usable) for (const x of sheet.scores) if (onRoll.has(x.studentId)) scores.set(x.studentId, { marks: x.marks as Marks, total: x.total });
      const totals = [...scores.values()].map((x) => x.total).filter((t): t is number => t !== null);
      const ranked = rank([...scores.entries()], ([, v]) => v.total);
      const positionById = new Map([...ranked].map(([[sid], pos]) => [sid, pos]));
      return {
        classSubjectId: s.id, code: s.subjectCode, name: subjectName(s.subjectCode), teacher: s.teacher,
        sheetId: sheet?.id ?? null, status: sheet?.status ?? null, entered: totals.length,
        scores, positionOf: (id: string) => positionById.get(id) ?? null,
        average: avg(totals), highest: totals.length ? Math.max(...totals) : null, lowest: totals.length ? Math.min(...totals) : null,
      };
    });
    const studentRows = roll
      .map((p) => {
        const totals = Object.fromEntries(subjectRows.map((s) => [s.code, s.scores.get(p.studentId)?.total ?? null])) as Record<string, number | null>;
        const got = Object.values(totals).filter((t): t is number => t !== null);
        return { id: p.studentId, learnerId: p.student.learnerId, fullName: fullName(p.student), totals, total: got.length ? round1(got.reduce((a, b) => a + b, 0)) : null, subjects: got.length, average: avg(got) };
      })
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
    const positions = rank(studentRows, (s) => s.average);
    return { subjects: subjectRows, students: studentRows.map((s) => ({ ...s, position: positions.get(s) ?? null })), ranked: positions.size };
  }

  private async classAccess(actor: AuthUser, classId: string, termId?: string) {
    const c = await this.prisma.classArm.findUnique({ where: { id: classId }, include: { school: { select: { id: true, name: true, lga: true } }, classTeacher: { select: { id: true, fullName: true } } } });
    const isSchool = actor.role === Role.SCHOOL_ADMIN && c?.schoolId === actor.schoolId;
    const isClassTeacher = actor.role === Role.TEACHER && c?.classTeacherId === actor.id;
    if (!c || !(isSchool || isClassTeacher || seesLga(actor, c.school.lga))) throw new NotFoundException('Class not found.');
    const term = await this.term(termId);
    if (term.sessionId !== c.sessionId) throw new BadRequestException(`${className(c.level, c.arm)} belongs to a different session from that term.`);
    const released = await this.prisma.classResult.findUnique({ where: { classArmId_termId: { classArmId: c.id, termId: term.id } }, include: { releasedBy: { select: { fullName: true } } } });
    if (isOversight(actor) && !released) throw new NotFoundException('These results have not been released yet.');
    return { c, term, released, isSchool, isClassTeacher };
  }

  /** The class broadsheet: each student's total in each subject, average and position, plus what is still needed before release. */
  async classResults(actor: AuthUser, classId: string, termId?: string) {
    const { c, term, released, isSchool, isClassTeacher } = await this.classAccess(actor, classId, termId);
    const data = await this.compute(c, term, !!released);
    const remarks = await this.prisma.reportRemark.findMany({ where: { classArmId: c.id, termId: term.id } });
    const remarkOf = new Map(remarks.map((r) => [r.studentId, r]));
    const blockers: string[] = [];
    if (!data.subjects.length) blockers.push('Add the subjects this class takes.');
    if (!data.students.length) blockers.push('There are no students in this class.');
    const notApproved = data.subjects.filter((s) => s.status !== SheetStatus.APPROVED);
    if (notApproved.length) blockers.push(`Approve every subject's scores. Not approved yet: ${notApproved.map((s) => s.name).join(', ')}.`);
    const open = term.isCurrent && !released;
    return {
      class: { id: c.id, name: className(c.level, c.arm), level: c.level, school: c.school, classTeacher: c.classTeacher },
      term: { id: term.id, name: termName(term.number), session: term.session.name, isCurrent: term.isCurrent, showPositions: term.showPositions },
      released: released ? { by: released.releasedBy.fullName, at: released.releasedAt } : null,
      canRelease: isSchool && open && !blockers.length,
      blockers: released ? [] : blockers,
      canEditTeacherRemarks: open && (isSchool || isClassTeacher),
      canEditPrincipalRemarks: open && isSchool,
      subjects: data.subjects.map(({ scores: _s, positionOf: _p, ...s }) => s),
      students: data.students.map((s) => ({
        ...s,
        teacherRemark: remarkOf.get(s.id)?.teacherRemark ?? null,
        principalRemark: remarkOf.get(s.id)?.principalRemark ?? null,
      })),
    };
  }

  async saveRemarks(actor: AuthUser, dto: { classId: string; remarks: { studentId: string; teacherRemark?: string | null; principalRemark?: string | null }[] }, ip: string | null) {
    const { c, term, released, isSchool, isClassTeacher } = await this.classAccess(actor, dto.classId);
    if (!isSchool && !isClassTeacher) throw new ForbiddenException('Only the class teacher or the school administrator can write remarks.');
    if (released) throw new ForbiddenException('These results have been released.');
    const roll = new Set((await this.sheets.roll(c.id, c.schoolId, term.endDate)).map((p) => p.studentId));
    for (const r of dto.remarks) {
      if (!roll.has(r.studentId)) throw new BadRequestException(`A student in the list is not in ${className(c.level, c.arm)}.`);
      if (r.principalRemark !== undefined && !isSchool) throw new ForbiddenException("Only the school administrator can write the principal's remark.");
    }
    await this.prisma.$transaction(async (tx) => {
      for (const r of dto.remarks) {
        const data: Prisma.ReportRemarkUncheckedUpdateInput = {};
        if (r.teacherRemark !== undefined) data.teacherRemark = r.teacherRemark || null;
        if (r.principalRemark !== undefined) data.principalRemark = r.principalRemark || null;
        await tx.reportRemark.upsert({
          where: { studentId_termId: { studentId: r.studentId, termId: term.id } },
          create: { studentId: r.studentId, termId: term.id, classArmId: c.id, teacherRemark: r.teacherRemark || null, principalRemark: r.principalRemark || null },
          update: { ...data, classArmId: c.id },
        });
      }
      await this.audit.record({ actorId: actor.id, action: 'remarks.saved', targetType: 'class', targetId: c.id, schoolId: c.schoolId, meta: { class: className(c.level, c.arm), term: termName(term.number), students: dto.remarks.length }, ip }, tx);
    });
    return this.classResults(actor, c.id);
  }

  async release(actor: AuthUser, classId: string, ip: string | null) {
    const r = await this.classResults(actor, classId);
    if (actor.role !== Role.SCHOOL_ADMIN) throw new ForbiddenException('Only the school administrator can release results.');
    if (r.released) throw new BadRequestException('These results have already been released.');
    if (!r.term.isCurrent) throw new BadRequestException('Results can only be released in the current term.');
    if (r.blockers.length) throw new BadRequestException(r.blockers.join(' '));
    await this.prisma.classResult.create({ data: { classArmId: classId, termId: r.term.id, releasedById: actor.id } });
    await this.audit.record({ actorId: actor.id, action: 'results.released', targetType: 'class', targetId: classId, schoolId: r.class.school.id, meta: { class: r.class.name, term: r.term.name, session: r.term.session, students: r.students.length }, ip });
    return this.classResults(actor, classId);
  }

  /** Terms a student has report cards for. Parents and the Ministry see released results only; the school and class teacher can preview. */
  async reportCardTerms(actor: AuthUser, studentId: string) {
    await this.students.assertCanView(actor, studentId);
    const placements = await this.prisma.classPlacement.findMany({
      where: { studentId },
      include: { classArm: { include: { results: { include: { term: { include: { session: true } } } } } } },
    });
    const current = await currentTerm(this.prisma);
    const out: { termId: string; name: string; session: string; className: string; released: boolean }[] = [];
    for (const p of placements) {
      for (const r of p.classArm.results) out.push({ termId: r.termId, name: termName(r.term.number), session: r.term.session.name, className: className(p.classArm.level, p.classArm.arm), released: true });
      const preview =
        current && current.sessionId === p.sessionId && !p.classArm.results.some((r) => r.termId === current.id) &&
        ((actor.role === Role.SCHOOL_ADMIN && p.classArm.schoolId === actor.schoolId) || (actor.role === Role.TEACHER && p.classArm.classTeacherId === actor.id));
      if (preview) out.push({ termId: current.id, name: termName(current.number), session: current.session.name, className: className(p.classArm.level, p.classArm.arm), released: false });
    }
    return out.sort((a, b) => b.session.localeCompare(a.session) || b.name.localeCompare(a.name));
  }

  async reportCard(actor: AuthUser, studentId: string, termId?: string) {
    await this.students.assertCanView(actor, studentId);
    const term = await this.term(termId);
    const placement = await this.prisma.classPlacement.findUnique({
      where: { studentId_sessionId: { studentId, sessionId: term.sessionId } },
      include: { classArm: { include: { school: { select: { id: true, name: true, code: true, lga: true, address: true } }, classTeacher: { select: { fullName: true } } } } },
    });
    if (!placement) throw new NotFoundException(`This student was not in a class in ${term.session.name}.`);
    const c = placement.classArm;
    const released = await this.prisma.classResult.findUnique({ where: { classArmId_termId: { classArmId: c.id, termId: term.id } } });
    const canPreview = (actor.role === Role.SCHOOL_ADMIN && c.schoolId === actor.schoolId) || (actor.role === Role.TEACHER && c.classTeacherId === actor.id);
    if (!released && !canPreview) throw new NotFoundException('This report card has not been released yet.');

    const data = await this.compute(c, term, !!released);
    const me = data.students.find((s) => s.id === studentId);
    if (!me) throw new NotFoundException('This student has no results for that term.');
    const components = term.components as unknown as Component[];
    const [student, remark, marks, nextTerm] = await Promise.all([
      this.prisma.student.findUniqueOrThrow({ where: { id: studentId } }),
      this.prisma.reportRemark.findUnique({ where: { studentId_termId: { studentId, termId: term.id } } }),
      this.prisma.attendanceMark.findMany({ where: { studentId, register: { date: { gte: term.startDate, lte: term.endDate } } }, select: { status: true } }),
      this.prisma.term.findUnique({ where: { sessionId_number: { sessionId: term.sessionId, number: term.number + 1 } } }),
    ]);
    const att = { PRESENT: 0, LATE: 0, ABSENT: 0, EXCUSED: 0 };
    marks.forEach((m) => att[m.status]++);
    const attMarked = marks.length;
    const enrolment = await this.prisma.enrolment.findFirst({ where: { studentId, schoolId: c.schoolId }, orderBy: { admittedOn: 'desc' } });

    return {
      released: !!released,
      student: { id: student.id, learnerId: student.learnerId, fullName: fullName(student), sex: student.sex, dateOfBirth: isoDate(student.dateOfBirth), admissionNumber: enrolment?.admissionNumber ?? null },
      school: c.school,
      class: { id: c.id, name: className(c.level, c.arm), classTeacher: c.classTeacher?.fullName ?? null, students: data.students.length },
      term: { id: term.id, name: termName(term.number), session: term.session.name, startDate: isoDate(term.startDate), endDate: isoDate(term.endDate), components, showPositions: term.showPositions },
      subjects: data.subjects
        .filter((s) => s.scores.has(studentId))
        .map((s) => {
          const sc = s.scores.get(studentId)!;
          const g = gradeFor(c.level, sc.total, term.sssGrading);
          return {
            code: s.code, name: s.name, marks: sc.marks, total: sc.total, grade: g?.grade ?? null, remark: g?.remark ?? null,
            classAverage: s.average, highest: s.highest, lowest: s.lowest,
            position: term.showPositions ? s.positionOf(studentId) : null,
          };
        }),
      summary: {
        subjects: me.subjects,
        total: me.total,
        average: me.average,
        position: term.showPositions && me.position ? ordinal(me.position) : null,
        outOf: data.ranked,
        classAverage: avg(data.students.map((s) => s.average).filter((a): a is number => a !== null)),
      },
      attendance: { ...att, marked: attMarked, rate: attMarked ? round1(((att.PRESENT + att.LATE) / attMarked) * 100) : null },
      remarks: { teacher: remark?.teacherRemark ?? null, principal: remark?.principalRemark ?? null },
      gradingScale: scaleFor(c.level, term.sssGrading),
      nextTermBegins: nextTerm ? isoDate(nextTerm.startDate) : null,
    };
  }

  /** Released results across schools (Ministry) or for one school: averages and pass rates by school and by subject. */
  async summary(actor: AuthUser, termId?: string, schoolId?: string) {
    const term = await this.term(termId);
    const scope = actor.role === Role.SCHOOL_ADMIN ? actor.schoolId! : schoolId;
    if (!isOversight(actor) && actor.role !== Role.SCHOOL_ADMIN) throw new ForbiddenException('You do not have access to this.');
    const released = await this.prisma.classResult.findMany({
      where: { termId: term.id, classArm: { ...(scope ? { schoolId: scope } : {}), ...(isOversight(actor) && actor.lga ? { school: schoolsInScope(actor) } : {}) } },
      include: { classArm: { include: { school: { select: { id: true, name: true, lga: true } } } } },
    });
    const classIds = released.map((r) => r.classArmId);
    const scores = await this.prisma.score.findMany({
      where: { total: { not: null }, sheet: { termId: term.id, status: SheetStatus.APPROVED, classSubject: { classArmId: { in: classIds } } } },
      select: { total: true, studentId: true, sheet: { select: { classSubject: { select: { subjectCode: true, classArm: { select: { schoolId: true, level: true } } } } } } },
    });
    const schools = new Map<string, { id: string; name: string; lga: string; classes: number; students: Set<string>; totals: number[] }>();
    for (const r of released) {
      const s = r.classArm.school;
      if (!schools.has(s.id)) schools.set(s.id, { ...s, classes: 0, students: new Set(), totals: [] });
      schools.get(s.id)!.classes++;
    }
    const subjects = new Map<string, number[]>();
    for (const x of scores) {
      const sch = schools.get(x.sheet.classSubject.classArm.schoolId)!;
      sch.students.add(x.studentId);
      sch.totals.push(x.total!);
      const code = x.sheet.classSubject.subjectCode;
      if (!subjects.has(code)) subjects.set(code, []);
      subjects.get(code)!.push(x.total!);
    }
    const rate = (xs: number[], min: number) => (xs.length ? round1((xs.filter((t) => t >= min).length / xs.length) * 100) : null);
    return {
      term: { id: term.id, name: termName(term.number), session: term.session.name },
      passMark: PASS_MARK,
      creditMark: CREDIT_MARK,
      schools: [...schools.values()]
        .map((s) => ({ id: s.id, name: s.name, lga: s.lga, classesReleased: s.classes, students: s.students.size, entries: s.totals.length, average: avg(s.totals), passRate: rate(s.totals, PASS_MARK), creditRate: rate(s.totals, CREDIT_MARK) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      subjects: [...subjects.entries()]
        .map(([code, xs]) => ({ code, name: subjectName(code), entries: xs.length, average: avg(xs), passRate: rate(xs, PASS_MARK), creditRate: rate(xs, CREDIT_MARK) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  /** Score sheets waiting for the school administrator, for the home screen. */
  async awaitingApproval(actor: AuthUser) {
    const term = await currentTerm(this.prisma);
    if (!term || actor.role !== Role.SCHOOL_ADMIN) return 0;
    return this.prisma.scoreSheet.count({ where: { termId: term.id, status: SheetStatus.SUBMITTED, classSubject: { classArm: { schoolId: actor.schoolId! } } } });
  }
}
