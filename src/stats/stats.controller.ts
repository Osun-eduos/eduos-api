import { Controller, Get } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthUser } from '../common/auth-user';
import { CurrentUser } from '../common/decorators';
import { MINISTRY_ROLES } from '../common/roles';
import { AttendanceService } from '../attendance/attendance.service';
import { PrismaService } from '../prisma/prisma.service';

@Controller('stats')
export class StatsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly attendance: AttendanceService,
  ) {}

  /** Account and school counts for the signed-in user's home screen. */
  @Get()
  async summary(@CurrentUser() me: AuthUser) {
    const scope = MINISTRY_ROLES.includes(me.role) ? {} : { schoolId: me.schoolId };
    const session = await this.prisma.academicSession.findFirst({ where: { isCurrent: true } });
    const studentScope = MINISTRY_ROLES.includes(me.role) ? {} : { currentSchoolId: me.schoolId };
    const [students, unplaced, classes] = await Promise.all([
      this.prisma.student.count({ where: { ...studentScope, status: 'ACTIVE' } }),
      this.prisma.student.count({ where: { ...studentScope, status: 'ACTIVE', placements: { none: { sessionId: session?.id ?? undefined } } } }),
      session ? this.prisma.classArm.count({ where: { sessionId: session.id, ...(MINISTRY_ROLES.includes(me.role) ? {} : { schoolId: me.schoolId! }) } }) : Promise.resolve(0),
    ]);
    const pendingTransfersIn = me.role === Role.SCHOOL_ADMIN ? await this.prisma.transfer.count({ where: { toSchoolId: me.schoolId!, status: 'REQUESTED' } }) : 0;
    const [byRole, schools, pending] = await Promise.all([
      this.prisma.user.groupBy({ by: ['role'], where: { ...scope, isActive: true }, _count: true }),
      MINISTRY_ROLES.includes(me.role) ? this.prisma.school.count({ where: { isActive: true } }) : Promise.resolve(null),
      this.prisma.user.count({ where: { ...scope, isActive: true, mustChangePassword: true } }),
    ]);
    const counts = Object.fromEntries(Object.values(Role).map((r) => [r, 0])) as Record<Role, number>;
    byRole.forEach((c) => (counts[c.role] = c._count));
    const attendanceToday = me.role === Role.SCHOOL_ADMIN || MINISTRY_ROLES.includes(me.role) ? await this.attendance.todayStats(me) : null;
    return { attendanceToday, accountsByRole: counts, schools, awaitingFirstSignIn: pending, students, unplaced, classes, session: session?.name ?? null, pendingTransfersIn };
  }
}
