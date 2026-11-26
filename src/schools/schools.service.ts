import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { isoDate } from '../common/dates';
import { Prisma, Role } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth-user';
import { LEVEL_CODES, LGAS } from '../common/lgas';
import { assertSeesLga, isOversight, schoolsInScope } from '../common/scope';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { CreateSchoolDto, UpdateSchoolDto } from './dto/school.dto';

@Injectable()
export class SchoolsService {
  constructor(private readonly prisma: PrismaService, private readonly users: UsersService, private readonly audit: AuditService) {}

  /** Next free school number, e.g. OS/OSG/JSS/0007. */
  private async nextCode(tx: Prisma.TransactionClient, lga: string, level: keyof typeof LEVEL_CODES) {
    const prefix = `OS/${LGAS[lga]}/${LEVEL_CODES[level]}/`;
    const last = await tx.school.findFirst({ where: { code: { startsWith: prefix } }, orderBy: { code: 'desc' }, select: { code: true } });
    const n = last ? parseInt(last.code.slice(prefix.length), 10) + 1 : 1;
    return prefix + String(n).padStart(4, '0');
  }

  async create(actor: AuthUser, dto: CreateSchoolDto, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      // Serialise code allocation so two schools never get the same number.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(42001)`;
      const code = await this.nextCode(tx, dto.lga, dto.level);
      const school = await tx.school.create({
        data: {
          code, name: dto.name, lga: dto.lga, level: dto.level, ownership: dto.ownership, address: dto.address,
          town: dto.town, yearEstablished: dto.yearEstablished, latitude: dto.latitude, longitude: dto.longitude,
          classrooms: dto.classrooms, expectedEnrolment: dto.expectedEnrolment, facilities: dto.facilities ? [...new Set(dto.facilities)] : [],
        },
      });
      await this.audit.record({ actorId: actor.id, action: 'school.created', targetType: 'school', targetId: school.id, schoolId: school.id, meta: { code }, ip }, tx);
      const admin = dto.admin ? await this.users.createInTx(tx, actor, dto.admin, Role.SCHOOL_ADMIN, school.id, ip) : null;
      return { school, admin };
    });
  }

  /** Active schools: all of them for schools (transfers), or those an oversight user may see. */
  directory(actor: AuthUser) {
    return this.prisma.school.findMany({ where: { isActive: true, ...(isOversight(actor) ? schoolsInScope(actor) : {}) }, select: { id: true, name: true, code: true, lga: true }, orderBy: [{ lga: 'asc' }, { name: 'asc' }] });
  }

  async list(actor: AuthUser, lga?: string, q?: string) {
    if (!isOversight(actor)) throw new ForbiddenException('You do not have access to this.');
    const schools = await this.prisma.school.findMany({
      where: {
        ...schoolsInScope(actor),
        ...(lga ? { lga } : {}),
        ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { code: { contains: q.toUpperCase() } }] } : {}),
      },
      orderBy: [{ lga: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { users: true, students: true } }, inspections: { orderBy: { visitedOn: 'desc' }, take: 1, select: { visitedOn: true, overall: true } } },
    });
    return schools.map(({ _count, inspections, ...s }) => ({
      ...s, accounts: _count.users, students: _count.students,
      lastInspection: inspections[0] ? { visitedOn: isoDate(inspections[0].visitedOn), overall: inspections[0].overall } : null,
      pendingInspection: !inspections.length,
    }));
  }

  async get(actor: AuthUser, id: string) {
    if (!isOversight(actor) && actor.schoolId !== id) throw new ForbiddenException('You do not have access to this.');
    const school = await this.prisma.school.findUnique({ where: { id } });
    if (!school) throw new NotFoundException('School not found.');
    if (isOversight(actor)) assertSeesLga(actor, school.lga);
    const counts = await this.prisma.user.groupBy({ by: ['role'], where: { schoolId: id }, _count: true });
    const students = await this.prisma.student.count({ where: { currentSchoolId: id, status: 'ACTIVE' } });
    const last = await this.prisma.inspection.findFirst({ where: { schoolId: id }, orderBy: { visitedOn: 'desc' }, select: { id: true, visitedOn: true, overall: true, answers: true } });
    const classrooms = (last?.answers as { classrooms?: { total?: number; usable?: number } } | undefined)?.classrooms;
    return {
      ...school, students,
      lastInspection: last ? { id: last.id, visitedOn: isoDate(last.visitedOn), overall: last.overall, classrooms: classrooms?.total ?? null, usableClassrooms: classrooms?.usable ?? null } : null,
      pendingInspection: !last, accountsByRole: Object.fromEntries(counts.map((c) => [c.role, c._count])) };
  }

  async update(actor: AuthUser, id: string, dto: UpdateSchoolDto, ip: string | null) {
    const school = await this.prisma.school.findUnique({ where: { id } });
    if (!school) throw new NotFoundException('School not found.');
    if (actor.role === Role.SCHOOL_ADMIN) {
      // A school keeps its own profile up to date; its name and status are the Ministry's.
      if (actor.schoolId !== id) throw new NotFoundException('School not found.');
      if (dto.name !== undefined || dto.isActive !== undefined || dto.address !== undefined) throw new ForbiddenException('Only the Ministry can change the school’s name, address or status.');
    } else if (actor.role !== Role.MINISTRY_ADMIN) {
      throw new ForbiddenException('You do not have access to this.');
    }
    if ((dto.latitude == null) !== (dto.longitude == null) && (dto.latitude !== undefined || dto.longitude !== undefined)) {
      throw new BadRequestException('Give both latitude and longitude, or neither.');
    }
    const data = { ...dto, ...(dto.facilities ? { facilities: [...new Set(dto.facilities)] } : {}) };
    const updated = await this.prisma.school.update({ where: { id }, data });
    if (dto.isActive === false) {
      await this.prisma.refreshToken.updateMany({ where: { user: { schoolId: id }, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    const action = dto.isActive === false ? 'school.deactivated' : dto.isActive === true && !school.isActive ? 'school.reactivated' : 'school.updated';
    await this.audit.record({ actorId: actor.id, action, targetType: 'school', targetId: id, schoolId: id, ip });
    return updated;
  }
}
