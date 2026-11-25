import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Role, SheetStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth-user';
import { className } from '../common/classes';
import { isOversight, seesLga } from '../common/scope';
import { Component, gradeFor, round1, subjectName, termName } from '../common/results';
import { currentTerm } from '../common/session';
import { PrismaService } from '../prisma/prisma.service';

export type Marks = Record<string, number | null>;

const csInclude = {
  teacher: { select: { id: true, fullName: true } },
  classArm: { include: { school: { select: { id: true, name: true, lga: true } } } },
} satisfies Prisma.ClassSubjectInclude;
type CsRow = Prisma.ClassSubjectGetPayload<{ include: typeof csInclude }>;

const studentSelect = { id: true, learnerId: true, surname: true, firstName: true, middleName: true } satisfies Prisma.StudentSelect;
const fullName = (s: { surname: string; firstName: string; middleName: string | null }) => [s.surname, s.firstName, s.middleName].filter(Boolean).join(' ');

/** Total when every component has a mark, otherwise null. */
export function totalOf(marks: Marks, components: Component[]) {
  let sum = 0;
  for (const c of components) {
    const v = marks[c.key];
    if (v === null || v === undefined) return null;
    sum += v;
  }
  return round1(sum);
}

@Injectable()
export class SheetsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /** Students on the class roll during a term: placed in the class and admitted to the school by the end of the term. */
  roll(classArmId: string, schoolId: string, termEnd: Date) {
    return this.prisma.classPlacement.findMany({
      where: { classArmId, student: { enrolments: { some: { schoolId, leftOn: null, admittedOn: { lte: termEnd } } } } },
      include: { student: { select: studentSelect } },
    });
  }

  private async load(actor: AuthUser, classSubjectId: string, termId?: string) {
    const cs = await this.prisma.classSubject.findUnique({ where: { id: classSubjectId }, include: csInclude });
    const c = cs?.classArm;
    const isSchool = actor.role === Role.SCHOOL_ADMIN && c?.schoolId === actor.schoolId;
    const isSubjectTeacher = actor.role === Role.TEACHER && cs?.teacherId === actor.id;
    const isClassTeacher = actor.role === Role.TEACHER && c?.classTeacherId === actor.id;
    if (!cs || !c || !(isSchool || isSubjectTeacher || isClassTeacher || seesLga(actor, c.school.lga))) throw new NotFoundException('Subject not found.');
    const term = termId ? await this.prisma.term.findUnique({ where: { id: termId }, include: { session: true } }) : await currentTerm(this.prisma);
    if (!term) throw new BadRequestException('The Ministry has not set the current term yet.');
    if (term.sessionId !== c.sessionId) throw new BadRequestException(`${className(c.level, c.arm)} belongs to a different session from that term.`);
    if (isOversight(actor)) {
      const released = await this.prisma.classResult.count({ where: { classArmId: c.id, termId: term.id } });
      if (!released) throw new NotFoundException('These results have not been released yet.');
    }
    const sheet = await this.prisma.scoreSheet.findUnique({
      where: { classSubjectId_termId: { classSubjectId: cs.id, termId: term.id } },
      include: { scores: { include: { student: { select: studentSelect } } }, submittedBy: { select: { fullName: true } }, decidedBy: { select: { fullName: true } } },
    });
    const released = !!(await this.prisma.classResult.findUnique({ where: { classArmId_termId: { classArmId: c.id, termId: term.id } } }));
    return { cs, c, term, sheet, released, canEdit: isSchool || isSubjectTeacher };
  }

  private lockedReason(ctx: Awaited<ReturnType<SheetsService['load']>>) {
    const status = ctx.sheet?.status ?? SheetStatus.DRAFT;
    if (!ctx.canEdit) return 'Only the subject teacher or the school administrator can enter these scores.';
    if (!ctx.term.isCurrent) return `${termName(ctx.term.number)} ${ctx.term.session.name} is not the current term.`;
    if (ctx.released) return 'These results have been released.';
    if (status === SheetStatus.SUBMITTED) return 'Submitted for approval. The school administrator can return it if something needs changing.';
    if (status === SheetStatus.APPROVED) return 'Approved. The school administrator can return it if something needs changing.';
    return null;
  }

  async get(actor: AuthUser, classSubjectId: string, termId?: string) {
    const ctx = await this.load(actor, classSubjectId, termId);
    const { cs, c, term, sheet } = ctx;
    const components = term.components as unknown as Component[];
    const roll = await this.roll(c.id, c.schoolId, term.endDate);
    const byStudent = new Map((sheet?.scores ?? []).map((s) => [s.studentId, s]));
    const rows = new Map<string, { id: string; learnerId: string; fullName: string; inClass: boolean; marks: Marks; total: number | null }>();
    const blank = Object.fromEntries(components.map((k) => [k.key, null])) as Marks;
    for (const p of roll) {
      const s = byStudent.get(p.studentId);
      rows.set(p.studentId, { id: p.student.id, learnerId: p.student.learnerId, fullName: fullName(p.student), inClass: true, marks: { ...blank, ...((s?.marks as Marks) ?? {}) }, total: s?.total ?? null });
    }
    for (const s of sheet?.scores ?? []) {
      if (!rows.has(s.studentId)) rows.set(s.studentId, { id: s.student.id, learnerId: s.student.learnerId, fullName: fullName(s.student), inClass: false, marks: { ...blank, ...(s.marks as Marks) }, total: s.total });
    }
    const students = [...rows.values()].sort((a, b) => a.fullName.localeCompare(b.fullName)).map((r) => ({ ...r, grade: gradeFor(c.level, r.total, term.sssGrading)?.grade ?? null }));
    const totals = students.filter((s) => s.inClass && s.total !== null).map((s) => s.total!);
    const lockedReason = this.lockedReason(ctx);
    return {
      id: sheet?.id ?? null,
      classSubject: { id: cs.id, code: cs.subjectCode, name: subjectName(cs.subjectCode), teacher: cs.teacher },
      class: { id: c.id, name: className(c.level, c.arm), level: c.level, school: c.school },
      term: { id: term.id, name: termName(term.number), session: term.session.name, isCurrent: term.isCurrent, components, sssGrading: term.sssGrading },
      status: sheet?.status ?? SheetStatus.DRAFT,
      returnNote: sheet?.returnNote ?? null,
      submitted: sheet?.submittedAt ? { by: sheet.submittedBy?.fullName ?? null, at: sheet.submittedAt } : null,
      decided: sheet?.decidedAt ? { by: sheet.decidedBy?.fullName ?? null, at: sheet.decidedAt } : null,
      editable: !lockedReason,
      lockedReason,
      released: ctx.released,
      students,
      summary: {
        students: students.filter((s) => s.inClass).length,
        complete: totals.length,
        average: totals.length ? round1(totals.reduce((a, b) => a + b, 0) / totals.length) : null,
        highest: totals.length ? Math.max(...totals) : null,
        lowest: totals.length ? Math.min(...totals) : null,
      },
    };
  }

  async save(actor: AuthUser, dto: { classSubjectId: string; scores: { studentId: string; marks: Marks }[] }, ip: string | null) {
    const ctx = await this.load(actor, dto.classSubjectId);
    const reason = this.lockedReason(ctx);
    if (reason) throw new ForbiddenException(reason);
    const { cs, c, term, sheet } = ctx;
    const components = term.components as unknown as Component[];
    const keys = new Map(components.map((k) => [k.key, k]));
    const roll = new Set((await this.roll(c.id, c.schoolId, term.endDate)).map((p) => p.studentId));
    const allowed = new Set([...roll, ...(sheet?.scores.map((s) => s.studentId) ?? [])]);
    const seen = new Set<string>();
    const names = new Map((sheet?.scores ?? []).map((s) => [s.studentId, fullName(s.student)]));

    for (const s of dto.scores) {
      if (seen.has(s.studentId)) throw new BadRequestException('Each student can appear only once.');
      seen.add(s.studentId);
      if (!allowed.has(s.studentId)) throw new BadRequestException(`A student in the list is not in ${className(c.level, c.arm)}.`);
      if (!s.marks || typeof s.marks !== 'object') throw new BadRequestException('Give marks for each student.');
      for (const [k, v] of Object.entries(s.marks)) {
        const comp = keys.get(k);
        if (!comp) throw new BadRequestException(`${k} is not one of this term's score components.`);
        if (v === null) continue;
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > comp.max || Math.round(v * 2) !== v * 2) {
          throw new BadRequestException(`${comp.label} marks must be between 0 and ${comp.max}, in whole or half marks${names.get(s.studentId) ? ` (${names.get(s.studentId)})` : ''}.`);
        }
      }
    }

    await this.prisma.$transaction(async (tx) => {
      const sh = sheet ?? (await tx.scoreSheet.create({ data: { classSubjectId: cs.id, termId: term.id } }));
      const existing = new Map((sheet?.scores ?? []).map((x) => [x.studentId, x.marks as Marks]));
      for (const s of dto.scores) {
        const marks = { ...Object.fromEntries(components.map((k) => [k.key, null])), ...(existing.get(s.studentId) ?? {}), ...s.marks } as Marks;
        const total = totalOf(marks, components);
        await tx.score.upsert({
          where: { sheetId_studentId: { sheetId: sh.id, studentId: s.studentId } },
          create: { sheetId: sh.id, studentId: s.studentId, marks: marks as Prisma.InputJsonValue, total },
          update: { marks: marks as Prisma.InputJsonValue, total },
        });
      }
      await tx.scoreSheet.update({ where: { id: sh.id }, data: { updatedAt: new Date() } });
      await this.audit.record(
        { actorId: actor.id, action: 'scores.saved', targetType: 'class', targetId: c.id, schoolId: c.schoolId, meta: { class: className(c.level, c.arm), subject: subjectName(cs.subjectCode), term: termName(term.number), students: dto.scores.length }, ip },
        tx,
      );
    });
    return this.get(actor, cs.id);
  }

  private async byId(actor: AuthUser, sheetId: string) {
    const sh = await this.prisma.scoreSheet.findUnique({ where: { id: sheetId } });
    if (!sh) throw new NotFoundException('Score sheet not found.');
    const ctx = await this.load(actor, sh.classSubjectId, sh.termId);
    if (!ctx.term.isCurrent) throw new ForbiddenException(`${termName(ctx.term.number)} ${ctx.term.session.name} is not the current term.`);
    if (ctx.released) throw new ForbiddenException('These results have been released.');
    return ctx;
  }

  private async decide(actor: AuthUser, ctx: Awaited<ReturnType<SheetsService['byId']>>, status: SheetStatus, action: string, ip: string | null, extra: Prisma.ScoreSheetUpdateInput = {}) {
    const { sheet, cs, c, term } = ctx;
    await this.prisma.scoreSheet.update({ where: { id: sheet!.id }, data: { status, ...extra } });
    await this.audit.record({
      actorId: actor.id, action, targetType: 'class', targetId: c.id, schoolId: c.schoolId,
      meta: { class: className(c.level, c.arm), subject: subjectName(cs.subjectCode), term: termName(term.number), ...(extra.returnNote ? { note: extra.returnNote as string } : {}) }, ip,
    });
    return this.get(actor, cs.id, term.id);
  }

  async submit(actor: AuthUser, sheetId: string, ip: string | null) {
    const ctx = await this.byId(actor, sheetId);
    if (!ctx.canEdit) throw new ForbiddenException('Only the subject teacher or the school administrator can submit these scores.');
    const sheet = ctx.sheet!;
    if (sheet.status !== SheetStatus.DRAFT && sheet.status !== SheetStatus.RETURNED) throw new BadRequestException('This score sheet has already been submitted.');
    const roll = await this.roll(ctx.c.id, ctx.c.schoolId, ctx.term.endDate);
    const done = new Set(sheet.scores.filter((s) => s.total !== null).map((s) => s.studentId));
    const missing = roll.filter((p) => !done.has(p.studentId));
    if (!roll.length) throw new BadRequestException('There are no students in this class.');
    if (missing.length) {
      throw new BadRequestException(`Enter every mark before submitting. Still missing: ${missing.slice(0, 3).map((p) => fullName(p.student)).join(', ')}${missing.length > 3 ? ` and ${missing.length - 3} more` : ''}.`);
    }
    return this.decide(actor, ctx, SheetStatus.SUBMITTED, 'scores.submitted', ip, { submittedBy: { connect: { id: actor.id } }, submittedAt: new Date(), returnNote: null });
  }

  async approve(actor: AuthUser, sheetId: string, ip: string | null) {
    const ctx = await this.byId(actor, sheetId);
    if (actor.role !== Role.SCHOOL_ADMIN || ctx.c.schoolId !== actor.schoolId) throw new ForbiddenException('Only the school administrator can approve scores.');
    if (ctx.sheet!.status !== SheetStatus.SUBMITTED) throw new BadRequestException('Only submitted score sheets can be approved.');
    return this.decide(actor, ctx, SheetStatus.APPROVED, 'scores.approved', ip, { decidedBy: { connect: { id: actor.id } }, decidedAt: new Date() });
  }

  async returnSheet(actor: AuthUser, sheetId: string, note: string, ip: string | null) {
    const ctx = await this.byId(actor, sheetId);
    if (actor.role !== Role.SCHOOL_ADMIN || ctx.c.schoolId !== actor.schoolId) throw new ForbiddenException('Only the school administrator can return scores.');
    if (ctx.sheet!.status !== SheetStatus.SUBMITTED && ctx.sheet!.status !== SheetStatus.APPROVED) throw new BadRequestException('Only submitted or approved score sheets can be returned.');
    return this.decide(actor, ctx, SheetStatus.RETURNED, 'scores.returned', ip, { decidedBy: { connect: { id: actor.id } }, decidedAt: new Date(), returnNote: note });
  }
}
