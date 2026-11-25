import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ClassArm, ClassLevel, Prisma, Role } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth-user';
import { className, LEVEL_ORDER, LEVELS_FOR_SCHOOL } from '../common/classes';
import { isOversight, seesLga } from '../common/scope';
import { currentSession, requireCurrentSession } from '../common/session';
import { PrismaService } from '../prisma/prisma.service';

type ArmWithExtras = ClassArm & { classTeacher: { id: string; fullName: string } | null; _count: { placements: number } };

export function classView(c: ArmWithExtras) {
  return {
    id: c.id, schoolId: c.schoolId, sessionId: c.sessionId, level: c.level, arm: c.arm, name: className(c.level, c.arm),
    capacity: c.capacity, students: c._count.placements, classTeacher: c.classTeacher,
  };
}

const include = { classTeacher: { select: { id: true, fullName: true } }, _count: { select: { placements: true } } } as const;

@Injectable()
export class ClassesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async levels(actor: AuthUser, schoolId?: string) {
    const id = actor.role === Role.SCHOOL_ADMIN ? actor.schoolId : schoolId;
    if (!id) throw new BadRequestException('Choose a school.');
    const school = await this.prisma.school.findUnique({ where: { id } });
    if (!school) throw new NotFoundException('School not found.');
    return LEVELS_FOR_SCHOOL[school.level];
  }

  async list(actor: AuthUser, schoolId?: string, sessionId?: string) {
    const session = sessionId ? { id: sessionId } : await currentSession(this.prisma);
    if (!session) return [];
    const where: Prisma.ClassArmWhereInput = { sessionId: session.id };
    if (isOversight(actor)) {
      if (!schoolId) throw new BadRequestException('Choose a school.');
      const school = await this.prisma.school.findUnique({ where: { id: schoolId }, select: { lga: true } });
      if (!school || !seesLga(actor, school.lga)) throw new NotFoundException('School not found.');
      where.schoolId = schoolId;
    } else if (actor.role === Role.SCHOOL_ADMIN) where.schoolId = actor.schoolId!;
    else if (actor.role === Role.TEACHER) where.classTeacherId = actor.id;
    else throw new ForbiddenException('You do not have access to this.');
    const rows = await this.prisma.classArm.findMany({ where, include });
    return rows
      .sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level) || a.arm.localeCompare(b.arm))
      .map(classView);
  }

  private async ownClass(actor: AuthUser, id: string) {
    const c = await this.prisma.classArm.findUnique({ where: { id }, include });
    if (!c || c.schoolId !== actor.schoolId) throw new NotFoundException('Class not found.');
    return c;
  }

  private async checkTeacher(actor: AuthUser, teacherId: string | null | undefined) {
    if (!teacherId) return;
    const t = await this.prisma.user.findUnique({ where: { id: teacherId } });
    if (!t || t.role !== Role.TEACHER || t.schoolId !== actor.schoolId || !t.isActive) {
      throw new BadRequestException('Choose an active teacher from your school.');
    }
  }

  async create(actor: AuthUser, dto: { level: ClassLevel; arm: string; capacity?: number; classTeacherId?: string }, ip: string | null) {
    const session = await requireCurrentSession(this.prisma);
    const school = await this.prisma.school.findUniqueOrThrow({ where: { id: actor.schoolId! } });
    if (!LEVELS_FOR_SCHOOL[school.level].includes(dto.level)) throw new BadRequestException('Your school does not teach that class level.');
    await this.checkTeacher(actor, dto.classTeacherId);
    const arm = dto.arm.trim().toUpperCase();
    try {
      const c = await this.prisma.classArm.create({
        data: { schoolId: school.id, sessionId: session.id, level: dto.level, arm, capacity: dto.capacity ?? 40, classTeacherId: dto.classTeacherId },
        include,
      });
      await this.audit.record({ actorId: actor.id, action: 'class.created', targetType: 'class', targetId: c.id, schoolId: school.id, meta: { name: className(c.level, c.arm), session: session.name }, ip });
      return classView(c);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException(`${className(dto.level, arm)} already exists this session.`);
      throw e;
    }
  }

  async update(actor: AuthUser, id: string, dto: { capacity?: number; classTeacherId?: string | null }, ip: string | null) {
    const c = await this.ownClass(actor, id);
    if (dto.capacity !== undefined && dto.capacity < c._count.placements) {
      throw new BadRequestException(`${className(c.level, c.arm)} already has ${c._count.placements} students.`);
    }
    await this.checkTeacher(actor, dto.classTeacherId);
    const u = await this.prisma.classArm.update({ where: { id }, data: { capacity: dto.capacity, classTeacherId: dto.classTeacherId }, include });
    await this.audit.record({ actorId: actor.id, action: 'class.updated', targetType: 'class', targetId: id, schoolId: c.schoolId, meta: { name: className(c.level, c.arm) }, ip });
    return classView(u);
  }

  async remove(actor: AuthUser, id: string, ip: string | null) {
    const c = await this.ownClass(actor, id);
    if (c._count.placements > 0) throw new BadRequestException('Move the students out of this class before removing it.');
    if (await this.prisma.attendanceRegister.count({ where: { classArmId: id } })) {
      throw new BadRequestException('This class has attendance records, so it cannot be removed.');
    }
    await this.prisma.classArm.delete({ where: { id } });
    await this.audit.record({ actorId: actor.id, action: 'class.removed', targetType: 'class', targetId: id, schoolId: c.schoolId, meta: { name: className(c.level, c.arm) }, ip });
  }
}
