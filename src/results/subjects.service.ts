import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth-user';
import { className } from '../common/classes';
import { MINISTRY_ROLES } from '../common/roles';
import { coreSubjectsFor, subjectByCode, subjectName, subjectsFor, termName } from '../common/results';
import { currentTerm } from '../common/session';
import { PrismaService } from '../prisma/prisma.service';

const include = {
  teacher: { select: { id: true, fullName: true } },
  classArm: { select: { id: true, level: true, arm: true, schoolId: true, sessionId: true, classTeacherId: true } },
} satisfies Prisma.ClassSubjectInclude;

@Injectable()
export class SubjectsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  catalogue(level: string) {
    const all = subjectsFor(level as never);
    const core = new Set(coreSubjectsFor(level as never).map((s) => s.code));
    return all.map((s) => ({ code: s.code, name: s.name, core: core.has(s.code) }));
  }

  private async classFor(actor: AuthUser, classId: string, edit: boolean) {
    const c = await this.prisma.classArm.findUnique({ where: { id: classId } });
    const visible =
      c &&
      (MINISTRY_ROLES.includes(actor.role) ||
        (actor.role === Role.SCHOOL_ADMIN && c.schoolId === actor.schoolId) ||
        (actor.role === Role.TEACHER && c.classTeacherId === actor.id));
    if (!c || !visible) throw new NotFoundException('Class not found.');
    if (edit && actor.role !== Role.SCHOOL_ADMIN) throw new ForbiddenException('Only the school administrator can change subjects.');
    return c;
  }

  async list(actor: AuthUser, classId: string) {
    const c = await this.classFor(actor, classId, false);
    const term = await currentTerm(this.prisma);
    const rows = await this.prisma.classSubject.findMany({
      where: { classArmId: c.id },
      include: { ...include, sheets: { where: { termId: term?.sessionId === c.sessionId ? term.id : '00000000-0000-0000-0000-000000000000' }, select: { id: true, status: true } } },
    });
    return rows
      .map((r) => ({ id: r.id, code: r.subjectCode, name: subjectName(r.subjectCode), teacher: r.teacher, sheet: r.sheets[0] ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private async checkTeacher(actor: AuthUser, teacherId?: string | null) {
    if (!teacherId) return;
    const t = await this.prisma.user.findUnique({ where: { id: teacherId } });
    if (!t || t.role !== Role.TEACHER || t.schoolId !== actor.schoolId || !t.isActive) throw new BadRequestException('Choose an active teacher from your school.');
  }

  async add(actor: AuthUser, classId: string, dto: { subjectCode: string; teacherId?: string }, ip: string | null) {
    const c = await this.classFor(actor, classId, true);
    const code = dto.subjectCode.toUpperCase();
    if (!subjectByCode.has(code) || !subjectsFor(c.level).some((s) => s.code === code)) {
      throw new BadRequestException('That subject is not taught at this class level.');
    }
    await this.checkTeacher(actor, dto.teacherId);
    try {
      const r = await this.prisma.classSubject.create({ data: { classArmId: c.id, subjectCode: code, teacherId: dto.teacherId }, include });
      await this.audit.record({ actorId: actor.id, action: 'subject.added', targetType: 'class', targetId: c.id, schoolId: c.schoolId, meta: { class: className(c.level, c.arm), subject: subjectName(code) }, ip });
      return { id: r.id, code, name: subjectName(code), teacher: r.teacher, sheet: null };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException(`${className(c.level, c.arm)} already takes ${subjectName(code)}.`);
      throw e;
    }
  }

  /** Adds the subjects every class at this level normally takes. Skips ones already added. */
  async addCore(actor: AuthUser, classId: string, ip: string | null) {
    const c = await this.classFor(actor, classId, true);
    const existing = new Set((await this.prisma.classSubject.findMany({ where: { classArmId: c.id } })).map((s) => s.subjectCode));
    const add = coreSubjectsFor(c.level).filter((s) => !existing.has(s.code));
    if (add.length) {
      await this.prisma.classSubject.createMany({ data: add.map((s) => ({ classArmId: c.id, subjectCode: s.code })) });
      await this.audit.record({ actorId: actor.id, action: 'subject.added', targetType: 'class', targetId: c.id, schoolId: c.schoolId, meta: { class: className(c.level, c.arm), subjects: add.map((s) => s.name) }, ip });
    }
    return this.list(actor, classId);
  }

  private async own(actor: AuthUser, id: string) {
    const r = await this.prisma.classSubject.findUnique({ where: { id }, include });
    if (!r || r.classArm.schoolId !== actor.schoolId) throw new NotFoundException('Subject not found.');
    return r;
  }

  async setTeacher(actor: AuthUser, id: string, teacherId: string | null, ip: string | null) {
    const r = await this.own(actor, id);
    await this.checkTeacher(actor, teacherId);
    const u = await this.prisma.classSubject.update({ where: { id }, data: { teacherId }, include });
    await this.audit.record({
      actorId: actor.id, action: 'subject.teacher_set', targetType: 'class', targetId: r.classArmId, schoolId: r.classArm.schoolId,
      meta: { class: className(r.classArm.level, r.classArm.arm), subject: subjectName(r.subjectCode), teacher: u.teacher?.fullName ?? null }, ip,
    });
    return { id: u.id, code: u.subjectCode, name: subjectName(u.subjectCode), teacher: u.teacher };
  }

  async remove(actor: AuthUser, id: string, ip: string | null) {
    const r = await this.own(actor, id);
    if (await this.prisma.scoreSheet.count({ where: { classSubjectId: id } })) throw new BadRequestException('Scores have been entered for this subject, so it cannot be removed.');
    await this.prisma.classSubject.delete({ where: { id } });
    await this.audit.record({ actorId: actor.id, action: 'subject.removed', targetType: 'class', targetId: r.classArmId, schoolId: r.classArm.schoolId, meta: { class: className(r.classArm.level, r.classArm.arm), subject: subjectName(r.subjectCode) }, ip });
  }

  /** Subjects a teacher teaches this session, with the current term's sheet status. */
  async mine(actor: AuthUser) {
    const term = await currentTerm(this.prisma);
    const session = await this.prisma.academicSession.findFirst({ where: { isCurrent: true } });
    if (!session) return { term: null, subjects: [] };
    const rows = await this.prisma.classSubject.findMany({
      where: { teacherId: actor.id, classArm: { sessionId: session.id } },
      include: { classArm: { include: { _count: { select: { placements: true } } } }, sheets: { where: { termId: term?.id ?? '00000000-0000-0000-0000-000000000000' }, select: { id: true, status: true, returnNote: true } } },
    });
    return {
      term: term ? { id: term.id, name: termName(term.number), session: term.session.name } : null,
      subjects: rows
        .map((r) => ({
          id: r.id, code: r.subjectCode, name: subjectName(r.subjectCode), class: { id: r.classArmId, name: className(r.classArm.level, r.classArm.arm) },
          students: r.classArm._count.placements, sheet: r.sheets[0] ?? null,
        }))
        .sort((a, b) => a.class.name.localeCompare(b.class.name) || a.name.localeCompare(b.name)),
    };
  }
}
