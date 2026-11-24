import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Role, StudentStatus, TransferStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth-user';
import { className } from '../common/classes';
import { nextAdmissionNumber } from '../common/counter';
import { isoDate, parseDate, today } from '../common/dates';
import { MINISTRY_ROLES } from '../common/roles';
import { currentSession } from '../common/session';
import { PrismaService } from '../prisma/prisma.service';

const include = {
  student: { select: { id: true, learnerId: true, surname: true, firstName: true, middleName: true, sex: true, dateOfBirth: true } },
  fromSchool: { select: { id: true, name: true, code: true, lga: true } },
  toSchool: { select: { id: true, name: true, code: true, lga: true } },
} as const;

type Row = Prisma.TransferGetPayload<{ include: typeof include }>;

@Injectable()
export class TransfersService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private async view(rows: Row[]) {
    const ids = [...new Set(rows.flatMap((r) => [r.requestedById, r.decidedById]).filter(Boolean))] as string[];
    const names = new Map((await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    const session = await currentSession(this.prisma);
    const placements = session
      ? await this.prisma.classPlacement.findMany({ where: { sessionId: session.id, studentId: { in: rows.map((r) => r.studentId) } }, include: { classArm: true } })
      : [];
    const cls = new Map(placements.map((p) => [p.studentId, className(p.classArm.level, p.classArm.arm)]));
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      reason: r.reason,
      note: r.note,
      requestedAt: r.requestedAt,
      decidedAt: r.decidedAt,
      requestedBy: names.get(r.requestedById) ?? null,
      decidedBy: r.decidedById ? names.get(r.decidedById) ?? null : null,
      fromSchool: r.fromSchool,
      toSchool: r.toSchool,
      student: {
        id: r.student.id, learnerId: r.student.learnerId, sex: r.student.sex, dateOfBirth: isoDate(r.student.dateOfBirth),
        fullName: [r.student.surname, r.student.firstName, r.student.middleName].filter(Boolean).join(' '),
        currentClass: r.status === TransferStatus.REQUESTED ? cls.get(r.studentId) ?? null : null,
      },
    }));
  }

  async list(actor: AuthUser) {
    let where: Prisma.TransferWhereInput = {};
    if (actor.role === Role.SCHOOL_ADMIN) where = { OR: [{ fromSchoolId: actor.schoolId! }, { toSchoolId: actor.schoolId! }] };
    else if (!MINISTRY_ROLES.includes(actor.role)) throw new ForbiddenException('You do not have access to this.');
    const rows = await this.prisma.transfer.findMany({ where, include, orderBy: { requestedAt: 'desc' }, take: 300 });
    return this.view(rows);
  }

  /** The student's current school asks another school to take the student. */
  async request(actor: AuthUser, dto: { studentId: string; toSchoolId: string; reason: string }, ip: string | null) {
    const student = await this.prisma.student.findUnique({ where: { id: dto.studentId } });
    if (!student || student.currentSchoolId !== actor.schoolId) throw new NotFoundException('Student not found.');
    if (student.status !== StudentStatus.ACTIVE) throw new BadRequestException('Only active students can be transferred.');
    if (dto.toSchoolId === actor.schoolId) throw new BadRequestException('Choose a different school.');
    const to = await this.prisma.school.findUnique({ where: { id: dto.toSchoolId } });
    if (!to || !to.isActive) throw new BadRequestException('Choose an active school.');
    const pending = await this.prisma.transfer.count({ where: { studentId: student.id, status: TransferStatus.REQUESTED } });
    if (pending) throw new ConflictException('This student already has a transfer waiting for a decision.');
    const t = await this.prisma.transfer.create({
      data: { studentId: student.id, fromSchoolId: actor.schoolId!, toSchoolId: to.id, reason: dto.reason, requestedById: actor.id },
      include,
    });
    await this.audit.record({ actorId: actor.id, action: 'transfer.requested', targetType: 'student', targetId: student.id, schoolId: actor.schoolId, meta: { to: to.name }, ip });
    await this.audit.record({ actorId: actor.id, action: 'transfer.received', targetType: 'student', targetId: student.id, schoolId: to.id, meta: { from: t.fromSchool.name }, ip });
    return (await this.view([t]))[0];
  }

  private async pending(id: string) {
    const t = await this.prisma.transfer.findUnique({ where: { id }, include });
    if (!t) throw new NotFoundException('Transfer not found.');
    if (t.status !== TransferStatus.REQUESTED) throw new BadRequestException('This transfer has already been decided.');
    return t;
  }

  /** The receiving school accepts: the student's record moves with a new admission number. */
  async accept(actor: AuthUser, id: string, dto: { classArmId?: string; admittedOn?: string }, ip: string | null) {
    const t = await this.pending(id);
    if (t.toSchoolId !== actor.schoolId) throw new NotFoundException('Transfer not found.');
    const date = dto.admittedOn ? parseDate(dto.admittedOn, 'Admission date') : today();
    await this.prisma.$transaction(async (tx) => {
      const student = await tx.student.findUniqueOrThrow({ where: { id: t.studentId } });
      if (student.currentSchoolId !== t.fromSchoolId || student.status !== StudentStatus.ACTIVE) {
        throw new ConflictException('The student is no longer at the sending school. The transfer cannot go ahead.');
      }
      const session = await currentSession(tx);
      if (dto.classArmId) {
        const c = await tx.classArm.findUnique({ where: { id: dto.classArmId } });
        if (!c || c.schoolId !== actor.schoolId || c.sessionId !== session?.id) throw new BadRequestException('Choose a class from your school for the current session.');
        const n = await tx.classPlacement.count({ where: { classArmId: c.id } });
        if (n >= c.capacity) throw new BadRequestException(`${className(c.level, c.arm)} is full (${c.capacity} students).`);
      }
      await tx.enrolment.updateMany({ where: { studentId: t.studentId, leftOn: null }, data: { leftOn: date, leftReason: `Transferred to ${t.toSchool.name}` } });
      await tx.enrolment.create({ data: { studentId: t.studentId, schoolId: actor.schoolId!, admissionNumber: await nextAdmissionNumber(tx, actor.schoolId!), admittedOn: date } });
      if (session) await tx.classPlacement.deleteMany({ where: { studentId: t.studentId, sessionId: session.id } });
      if (dto.classArmId && session) await tx.classPlacement.create({ data: { studentId: t.studentId, classArmId: dto.classArmId, sessionId: session.id } });
      await tx.student.update({ where: { id: t.studentId }, data: { currentSchoolId: actor.schoolId } });
      // Parents whose only children at the old school have now left follow the child, so the new school can support their account.
      const guardians = await tx.studentGuardian.findMany({ where: { studentId: t.studentId }, include: { parent: true } });
      for (const g of guardians) {
        if (g.parent.schoolId !== t.fromSchoolId) continue;
        const stillThere = await tx.studentGuardian.count({ where: { parentId: g.parentId, student: { currentSchoolId: t.fromSchoolId } } });
        if (!stillThere) await tx.user.update({ where: { id: g.parentId }, data: { schoolId: actor.schoolId } });
      }
      await tx.transfer.update({ where: { id }, data: { status: TransferStatus.ACCEPTED, decidedById: actor.id, decidedAt: new Date() } });
      for (const schoolId of [t.fromSchoolId, t.toSchoolId]) {
        await this.audit.record({ actorId: actor.id, action: 'transfer.accepted', targetType: 'student', targetId: t.studentId, schoolId, meta: { from: t.fromSchool.name, to: t.toSchool.name }, ip }, tx);
      }
    });
    return (await this.view([await this.prisma.transfer.findUniqueOrThrow({ where: { id }, include })]))[0];
  }

  async reject(actor: AuthUser, id: string, note: string | undefined, ip: string | null) {
    const t = await this.pending(id);
    if (t.toSchoolId !== actor.schoolId) throw new NotFoundException('Transfer not found.');
    return this.close(actor, t, TransferStatus.REJECTED, note, ip);
  }

  async cancel(actor: AuthUser, id: string, ip: string | null) {
    const t = await this.pending(id);
    if (t.fromSchoolId !== actor.schoolId) throw new NotFoundException('Transfer not found.');
    return this.close(actor, t, TransferStatus.CANCELLED, undefined, ip);
  }

  private async close(actor: AuthUser, t: Row, status: TransferStatus, note: string | undefined, ip: string | null) {
    const u = await this.prisma.transfer.update({ where: { id: t.id }, data: { status, note, decidedById: actor.id, decidedAt: new Date() }, include });
    const action = status === TransferStatus.REJECTED ? 'transfer.rejected' : 'transfer.cancelled';
    for (const schoolId of [t.fromSchoolId, t.toSchoolId]) {
      await this.audit.record({ actorId: actor.id, action, targetType: 'student', targetId: t.studentId, schoolId, meta: { from: t.fromSchool.name, to: t.toSchool.name }, ip });
    }
    return (await this.view([u]))[0];
  }
}
