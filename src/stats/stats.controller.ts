import { Controller, Get } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthUser } from '../common/auth-user';
import { CurrentUser } from '../common/decorators';
import { isOversight, schoolsInScope } from '../common/scope';
import { AttendanceService } from '../attendance/attendance.service';
import { PrismaService } from '../prisma/prisma.service';
import { ResultsService } from '../results/results.service';
import { StaffService } from '../staff/staff.service';
import { currentTerm } from '../common/session';
import { termName } from '../common/results';

@Controller('stats')
export class StatsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly attendance: AttendanceService,
    private readonly results: ResultsService,
    private readonly staffService: StaffService,
  ) {}

  /** Account and school counts for the signed-in user's home screen. */
  @Get()
  async summary(@CurrentUser() me: AuthUser) {
    // Oversight users count everything in their area (the state, or one LGA); everyone else counts their school.
    const oversight = isOversight(me);
    const area = schoolsInScope(me);
    const scope = oversight ? (me.lga ? { school: area } : {}) : { schoolId: me.schoolId };
    const session = await this.prisma.academicSession.findFirst({ where: { isCurrent: true } });
    const studentScope = oversight ? (me.lga ? { currentSchool: area } : {}) : { currentSchoolId: me.schoolId };
    const [students, unplaced, classes] = await Promise.all([
      this.prisma.student.count({ where: { ...studentScope, status: 'ACTIVE' } }),
      this.prisma.student.count({ where: { ...studentScope, status: 'ACTIVE', placements: { none: { sessionId: session?.id ?? undefined } } } }),
      session ? this.prisma.classArm.count({ where: { sessionId: session.id, ...(oversight ? (me.lga ? { school: area } : {}) : { schoolId: me.schoolId! }) } }) : Promise.resolve(0),
    ]);
    const pendingTransfersIn = me.role === Role.SCHOOL_ADMIN ? await this.prisma.transfer.count({ where: { toSchoolId: me.schoolId!, status: 'REQUESTED' } }) : 0;
    const [byRole, schools, pending] = await Promise.all([
      this.prisma.user.groupBy({ by: ['role'], where: { ...scope, isActive: true }, _count: true }),
      oversight ? this.prisma.school.count({ where: { isActive: true, ...area } }) : Promise.resolve(null),
      this.prisma.user.count({ where: { ...scope, isActive: true, mustChangePassword: true } }),
    ]);
    const counts = Object.fromEntries(Object.values(Role).map((r) => [r, 0])) as Record<Role, number>;
    byRole.forEach((c) => (counts[c.role] = c._count));
    const attendanceToday = me.role === Role.SCHOOL_ADMIN || oversight ? await this.attendance.todayStats(me) : null;
    const staff = me.role === Role.SCHOOL_ADMIN || oversight
      ? await this.staffService.counts(oversight ? (me.lga ? { currentSchool: area } : { currentSchoolId: { not: null } }) : { currentSchoolId: me.schoolId })
      : null;
    // Teachers per pupil, e.g. 35 means one teacher for every 35 students.
    const pupilsPerTeacher = staff?.teaching ? Math.round((students / staff.teaching) * 10) / 10 : null;
    const pendingStaffTransfers = me.role === Role.MINISTRY_ADMIN ? await this.prisma.postingRequest.count({ where: { status: 'REQUESTED' } }) : 0;
    const term = await currentTerm(this.prisma);
    const scoresAwaitingApproval = await this.results.awaitingApproval(me);
    return { lga: me.lga, term: term ? { id: term.id, name: termName(term.number), session: term.session.name } : null, scoresAwaitingApproval, attendanceToday, accountsByRole: counts, schools, awaitingFirstSignIn: pending, students, unplaced, classes, session: session?.name ?? null, pendingTransfersIn, staff, pupilsPerTeacher, pendingStaffTransfers };
  }
}
