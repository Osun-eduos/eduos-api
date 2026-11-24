import { Controller, Get, Query } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { AuthUser } from '../common/auth-user';
import { CurrentUser, Roles } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';

@Controller('audit')
@Roles(Role.MINISTRY_ADMIN, Role.SCHOOL_ADMIN)
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  /** Recent activity. School administrators see their own school only. */
  @Get()
  async list(@CurrentUser() me: AuthUser, @Query('take') take = '100') {
    const where: Prisma.AuditLogWhereInput = me.role === Role.SCHOOL_ADMIN ? { schoolId: me.schoolId } : {};
    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(parseInt(take, 10) || 100, 1), 500),
    });
    const ids = [...new Set(rows.flatMap((r) => [r.actorId, r.targetType === 'user' ? r.targetId : null]).filter(Boolean))] as string[];
    const users = await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } });
    const name = new Map(users.map((u) => [u.id, u.fullName]));
    return rows.map((r) => ({
      ...r,
      actorName: r.actorId ? name.get(r.actorId) ?? null : null,
      targetName: r.targetType === 'user' && r.targetId ? name.get(r.targetId) ?? null : null,
    }));
  }
}
