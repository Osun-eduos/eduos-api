import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth-user';
import { LEVEL_CODES, LGAS } from '../common/lgas';
import { MINISTRY_ROLES } from '../common/roles';
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
        data: { code, name: dto.name, lga: dto.lga, level: dto.level, ownership: dto.ownership, address: dto.address },
      });
      await this.audit.record({ actorId: actor.id, action: 'school.created', targetType: 'school', targetId: school.id, schoolId: school.id, meta: { code }, ip }, tx);
      const admin = dto.admin ? await this.users.createInTx(tx, actor, dto.admin, Role.SCHOOL_ADMIN, school.id, ip) : null;
      return { school, admin };
    });
  }

  async list(actor: AuthUser, lga?: string, q?: string) {
    if (!MINISTRY_ROLES.includes(actor.role)) throw new ForbiddenException('You do not have access to this.');
    const schools = await this.prisma.school.findMany({
      where: {
        ...(lga ? { lga } : {}),
        ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { code: { contains: q.toUpperCase() } }] } : {}),
      },
      orderBy: [{ lga: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { users: true } } },
    });
    return schools.map(({ _count, ...s }) => ({ ...s, accounts: _count.users }));
  }

  async get(actor: AuthUser, id: string) {
    if (!MINISTRY_ROLES.includes(actor.role) && actor.schoolId !== id) throw new ForbiddenException('You do not have access to this.');
    const school = await this.prisma.school.findUnique({ where: { id } });
    if (!school) throw new NotFoundException('School not found.');
    const counts = await this.prisma.user.groupBy({ by: ['role'], where: { schoolId: id }, _count: true });
    return { ...school, accountsByRole: Object.fromEntries(counts.map((c) => [c.role, c._count])) };
  }

  async update(actor: AuthUser, id: string, dto: UpdateSchoolDto, ip: string | null) {
    const school = await this.prisma.school.findUnique({ where: { id } });
    if (!school) throw new NotFoundException('School not found.');
    const updated = await this.prisma.school.update({ where: { id }, data: dto });
    if (dto.isActive === false) {
      await this.prisma.refreshToken.updateMany({ where: { user: { schoolId: id }, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    const action = dto.isActive === false ? 'school.deactivated' : dto.isActive === true && !school.isActive ? 'school.reactivated' : 'school.updated';
    await this.audit.record({ actorId: actor.id, action, targetType: 'school', targetId: id, schoolId: id, ip });
    return updated;
  }
}
