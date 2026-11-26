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

  /**
   * Students without a class this session, and the level each should join: the level they enrolled at, or the
   * level after last session's class for returning students. Also each arm's size and sex balance.
   */
  async allocation(actor: AuthUser) {
    const { school, session } = await this.ownSchool(actor);
    const levels = LEVELS_FOR_SCHOOL[school.level];
    const [arms, unplaced] = await Promise.all([
      this.prisma.classArm.findMany({ where: { schoolId: school.id, sessionId: session.id }, include: { placements: { select: { student: { select: { sex: true } } } } }, orderBy: [{ level: 'asc' }, { arm: 'asc' }] }),
      this.prisma.student.findMany({
        where: { currentSchoolId: school.id, status: 'ACTIVE', placements: { none: { sessionId: session.id } } },
        include: {
          enrolments: { where: { leftOn: null, schoolId: school.id }, select: { entryLevel: true } },
          placements: { where: { classArm: { schoolId: school.id } }, include: { classArm: { select: { level: true } }, session: { select: { startDate: true } } } },
        },
        orderBy: [{ surname: 'asc' }, { firstName: 'asc' }],
      }),
    ]);
    const target = (st: (typeof unplaced)[number]): { level: ClassLevel | null; reason: string | null } => {
      const last = [...st.placements].sort((a, b) => b.session.startDate.getTime() - a.session.startDate.getTime())[0];
      if (last) {
        const next = LEVEL_ORDER[LEVEL_ORDER.indexOf(last.classArm.level) + 1];
        if (next && levels.includes(next)) return { level: next, reason: null };
        return { level: null, reason: 'Has finished the last class this school teaches.' };
      }
      const entry = st.enrolments[0]?.entryLevel;
      if (entry) return { level: entry, reason: null };
      return { level: null, reason: 'No entry class was recorded. Choose a class on their record.' };
    };
    const rows = unplaced.map((st) => ({ id: st.id, fullName: [st.surname, st.firstName, st.middleName].filter(Boolean).join(' '), sex: st.sex, ...target(st) }));
    return {
      session: session.name,
      levels: levels.map((level) => ({
        level,
        arms: arms.filter((a) => a.level === level).map((a) => ({
          id: a.id, name: className(a.level, a.arm), capacity: a.capacity, students: a.placements.length,
          girls: a.placements.filter((p) => p.student.sex === 'F').length, boys: a.placements.filter((p) => p.student.sex === 'M').length,
        })),
        unplaced: rows.filter((r) => r.level === level),
      })).filter((l) => l.arms.length || l.unplaced.length),
      unknown: rows.filter((r) => !r.level),
    };
  }

  /** Places waiting students in the arms of a level, filling the smallest arm first and keeping girls and boys balanced. */
  async autoAllocate(actor: AuthUser, level: ClassLevel, ip: string | null) {
    const { school, session } = await this.ownSchool(actor);
    const data = await this.allocation(actor);
    const lv = data.levels.find((l) => l.level === level);
    if (!lv || !lv.unplaced.length) return { placed: 0, full: 0 };
    if (!lv.arms.length) throw new BadRequestException(`Add a ${className(level, '').trim()} class first.`);
    const arms = lv.arms.map((a) => ({ ...a }));
    // Alternate girls and boys so each arm gets a fair share of both.
    const girls = lv.unplaced.filter((u) => u.sex === 'F');
    const boys = lv.unplaced.filter((u) => u.sex === 'M');
    const order: typeof lv.unplaced = [];
    while (girls.length || boys.length) {
      if (girls.length) order.push(girls.shift()!);
      if (boys.length) order.push(boys.shift()!);
    }
    const plan: { studentId: string; classArmId: string; name: string; arm: string }[] = [];
    let full = 0;
    for (const st of order) {
      const key = st.sex === 'F' ? 'girls' : 'boys';
      const open = arms.filter((a) => a.students < a.capacity).sort((a, b) => a.students - b.students || a[key] - b[key] || a.name.localeCompare(b.name));
      if (!open.length) { full++; continue; }
      const arm = open[0];
      arm.students++;
      arm[key]++;
      plan.push({ studentId: st.id, classArmId: arm.id, name: st.fullName, arm: arm.name });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.classPlacement.createMany({ data: plan.map((p) => ({ studentId: p.studentId, classArmId: p.classArmId, sessionId: session.id })), skipDuplicates: true });
      await this.audit.record({ actorId: actor.id, action: 'students.auto_allocated', targetType: 'school', targetId: school.id, schoolId: school.id, meta: { level, placed: plan.length, full }, ip }, tx);
    });
    return { placed: plan.length, full };
  }

  private async ownSchool(actor: AuthUser) {
    if (actor.role !== Role.SCHOOL_ADMIN) throw new ForbiddenException('Only the school can allocate classes.');
    const school = await this.prisma.school.findUniqueOrThrow({ where: { id: actor.schoolId! } });
    const session = await requireCurrentSession(this.prisma);
    return { school, session };
  }
}
