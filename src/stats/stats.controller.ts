import { Controller, Get } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthUser } from '../common/auth-user';
import { CurrentUser } from '../common/decorators';
import { MINISTRY_ROLES } from '../common/roles';
import { PrismaService } from '../prisma/prisma.service';

@Controller('stats')
export class StatsController {
  constructor(private readonly prisma: PrismaService) {}

  /** Account and school counts for the signed-in user's home screen. */
  @Get()
  async summary(@CurrentUser() me: AuthUser) {
    const scope = MINISTRY_ROLES.includes(me.role) ? {} : { schoolId: me.schoolId };
    const [byRole, schools, pending] = await Promise.all([
      this.prisma.user.groupBy({ by: ['role'], where: { ...scope, isActive: true }, _count: true }),
      MINISTRY_ROLES.includes(me.role) ? this.prisma.school.count({ where: { isActive: true } }) : Promise.resolve(null),
      this.prisma.user.count({ where: { ...scope, isActive: true, mustChangePassword: true } }),
    ]);
    const counts = Object.fromEntries(Object.values(Role).map((r) => [r, 0])) as Record<Role, number>;
    byRole.forEach((c) => (counts[c.role] = c._count));
    return { accountsByRole: counts, schools, awaitingFirstSignIn: pending };
  }
}
