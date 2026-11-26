import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Post, Put, Query, Req } from '@nestjs/common';
import { Role, StaffAttendanceStatus, StaffStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEnum, IsOptional, IsUUID, Matches, ValidateNested } from 'class-validator';
import { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth-user';
import { addDays, isoDate, parseDate, today } from '../common/dates';
import { CurrentUser, Roles } from '../common/decorators';
import { holidayOn } from '../common/holidays';
import { subjectName } from '../common/results';
import { OVERSIGHT_ROLES } from '../common/roles';
import { isOversight } from '../common/scope';
import { currentSession } from '../common/session';
import { PrismaService } from '../prisma/prisma.service';

/** Staff who clock in after this time (Lagos time) are marked late. */
export const STAFF_LATE_AFTER = '08:00';
/** Hours of training a teacher should have each session. */
export const TRAINING_TARGET_HOURS = 40;
/** Pupils one subject teacher can carry, for working out shortages. */
export const PUPILS_PER_SUBJECT_TEACHER = 40;
/** How far back a school can correct its staff register. */
const CORRECTION_DAYS = 14;

class MarkDto {
  @IsUUID() staffId!: string;
  @IsEnum(StaffAttendanceStatus) status!: StaffAttendanceStatus;
}
class SaveDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/) date!: string;
  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => MarkDto) marks!: MarkDto[];
}
class DateQuery {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) date?: string;
}

const name = (s: { surname: string; firstName: string; middleName: string | null }) => [s.surname, s.firstName, s.middleName].filter(Boolean).join(' ');
/** Minutes past midnight in Lagos (UTC+1, no daylight saving). */
const lagosMinutes = (d: Date) => ((d.getUTCHours() + 1) % 24) * 60 + d.getUTCMinutes();

@Controller()
export class StaffAttendanceController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private day(value?: string) {
    const d = value ? parseDate(value, 'Date') : today();
    if (d > today()) throw new BadRequestException('You cannot mark a day that has not happened yet.');
    return d;
  }

  /** The school's staff register for a day. */
  @Get('staff-attendance')
  @Roles(Role.SCHOOL_ADMIN)
  async register(@CurrentUser() me: AuthUser, @Query() q: DateQuery) {
    const date = this.day(q.date);
    const [staff, marks, holiday] = await Promise.all([
      this.prisma.staff.findMany({ where: { currentSchoolId: me.schoolId!, status: { in: [StaffStatus.ACTIVE, StaffStatus.ON_LEAVE] } }, orderBy: [{ surname: 'asc' }, { firstName: 'asc' }] }),
      this.prisma.staffAttendance.findMany({ where: { schoolId: me.schoolId!, date } }),
      holidayOn(this.prisma, date),
    ]);
    const byStaff = new Map(marks.map((m) => [m.staffId, m]));
    const rows = staff.map((s) => {
      const m = byStaff.get(s.id);
      return { staffId: s.id, staffNumber: s.staffNumber, fullName: name(s), category: s.category, rank: s.rank, onLeave: s.status === StaffStatus.ON_LEAVE, status: m?.status ?? null, clockedInAt: m?.clockedInAt ?? null };
    });
    const count = (st: StaffAttendanceStatus) => rows.filter((r) => r.status === st).length;
    return {
      date: isoDate(date), holiday: holiday?.name ?? null, weekend: date.getUTCDay() === 0 || date.getUTCDay() === 6,
      editable: date >= addDays(today(), -CORRECTION_DAYS), lateAfter: STAFF_LATE_AFTER,
      summary: { staff: rows.length, marked: rows.filter((r) => r.status).length, PRESENT: count('PRESENT'), LATE: count('LATE'), ABSENT: count('ABSENT'), LEAVE: count('LEAVE') },
      staff: rows,
    };
  }

  @Put('staff-attendance')
  @Roles(Role.SCHOOL_ADMIN)
  async save(@CurrentUser() me: AuthUser, @Body() dto: SaveDto, @Req() req: Request) {
    const date = this.day(dto.date);
    if (date < addDays(today(), -CORRECTION_DAYS)) throw new BadRequestException(`The staff register can be corrected for up to ${CORRECTION_DAYS} days.`);
    const ids = dto.marks.map((m) => m.staffId);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Each member of staff can appear only once.');
    const own = await this.prisma.staff.count({ where: { id: { in: ids }, currentSchoolId: me.schoolId! } });
    if (own !== ids.length) throw new BadRequestException('Someone in the list is not on your school’s staff.');
    await this.prisma.$transaction(async (tx) => {
      for (const m of dto.marks) {
        await tx.staffAttendance.upsert({
          where: { staffId_date: { staffId: m.staffId, date } },
          create: { staffId: m.staffId, schoolId: me.schoolId!, date, status: m.status, markedById: me.id },
          update: { status: m.status, markedById: me.id, schoolId: me.schoolId! },
        });
      }
      await this.audit.record({ actorId: me.id, action: 'staff.register_saved', targetType: 'school', targetId: me.schoolId!, schoolId: me.schoolId!, meta: { date: isoDate(date), marks: dto.marks.length }, ip: req.ip ?? null }, tx);
    });
    return this.register(me, { date: dto.date });
  }

  /** A teacher or administrator signs in for the day from the app or the web. */
  @Post('staff-attendance/clock-in')
  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN)
  @HttpCode(200)
  async clockIn(@CurrentUser() me: AuthUser) {
    const staff = await this.prisma.staff.findUnique({ where: { userId: me.id } });
    if (!staff || !staff.currentSchoolId) throw new ForbiddenException('Your account is not linked to a staff record. Ask your school administrator to link it.');
    const date = today();
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) throw new BadRequestException('There is no school today.');
    if (await holidayOn(this.prisma, date)) throw new BadRequestException('Today is a public holiday.');
    const existing = await this.prisma.staffAttendance.findUnique({ where: { staffId_date: { staffId: staff.id, date } } });
    if (existing) return { date: isoDate(date), status: existing.status, clockedInAt: existing.clockedInAt, already: true };
    const now = new Date();
    const [h, m] = STAFF_LATE_AFTER.split(':').map(Number);
    const status = lagosMinutes(now) > h * 60 + m ? StaffAttendanceStatus.LATE : StaffAttendanceStatus.PRESENT;
    const row = await this.prisma.staffAttendance.create({ data: { staffId: staff.id, schoolId: staff.currentSchoolId, date, status, clockedInAt: now, markedById: me.id } });
    return { date: isoDate(date), status: row.status, clockedInAt: row.clockedInAt, already: false };
  }

  @Get('staff-attendance/me')
  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN)
  async mine(@CurrentUser() me: AuthUser) {
    const staff = await this.prisma.staff.findUnique({ where: { userId: me.id } });
    if (!staff) return { linked: false, today: null };
    const row = await this.prisma.staffAttendance.findUnique({ where: { staffId_date: { staffId: staff.id, date: today() } } });
    return { linked: true, today: row ? { status: row.status, clockedInAt: row.clockedInAt } : null };
  }

  /**
   * For the Ministry, LGAs and schools: who is in today, training hours against the target, and subjects short of
   * teachers at one teacher per 40 pupils.
   */
  @Get('staff/insights')
  @Roles(...OVERSIGHT_ROLES, Role.SCHOOL_ADMIN)
  async insights(@CurrentUser() me: AuthUser, @Query() q: DateQuery) {
    const lga = isOversight(me) ? me.lga ?? null : null;
    const schoolId = me.role === Role.SCHOOL_ADMIN ? me.schoolId! : null;
    const date = this.day(q.date);
    const session = await currentSession(this.prisma);

    const att = await this.prisma.$queryRaw<{ lga: string; staff: bigint; schools: bigint; registers: bigint; present: bigint; late: bigint; absent: bigint; leave: bigint }[]>`
      SELECT s.lga, count(st.id) AS staff, count(DISTINCT s.id) AS schools, count(DISTINCT sa."schoolId") AS registers,
        count(sa.id) FILTER (WHERE sa.status = 'PRESENT') AS present, count(sa.id) FILTER (WHERE sa.status = 'LATE') AS late,
        count(sa.id) FILTER (WHERE sa.status = 'ABSENT') AS absent, count(sa.id) FILTER (WHERE sa.status = 'LEAVE') AS leave
      FROM "Staff" st JOIN "School" s ON s.id = st."currentSchoolId"
      LEFT JOIN "StaffAttendance" sa ON sa."staffId" = st.id AND sa.date = ${date}
      WHERE st.status IN ('ACTIVE', 'ON_LEAVE') AND s."isActive" AND (${lga}::text IS NULL OR s.lga = ${lga}) AND (${schoolId}::uuid IS NULL OR s.id = ${schoolId}::uuid)
      GROUP BY s.lga ORDER BY s.lga`;
    const n = (x: bigint) => Number(x);
    const byLga = att.map((r) => {
      const marked = n(r.present) + n(r.late) + n(r.absent) + n(r.leave);
      return { lga: r.lga, staff: n(r.staff), schools: n(r.schools), schoolsMarked: n(r.registers), marked, present: n(r.present), late: n(r.late), absent: n(r.absent), leave: n(r.leave), presentRate: marked ? Math.round(((n(r.present) + n(r.late)) / marked) * 1000) / 10 : null };
    });
    const total = byLga.reduce((a, r) => ({ staff: a.staff + r.staff, marked: a.marked + r.marked, present: a.present + r.present, late: a.late + r.late, absent: a.absent + r.absent, leave: a.leave + r.leave, schools: a.schools + r.schools, schoolsMarked: a.schoolsMarked + r.schoolsMarked }), { staff: 0, marked: 0, present: 0, late: 0, absent: 0, leave: 0, schools: 0, schoolsMarked: 0 });

    // Training hours this session per teacher.
    const from = session?.startDate ?? addDays(today(), -365);
    const to = session?.endDate ?? today();
    const hours = await this.prisma.$queryRaw<{ hours: bigint }[]>`
      SELECT coalesce(sum(t.hours), 0) AS hours
      FROM "Staff" st JOIN "School" s ON s.id = st."currentSchoolId"
      LEFT JOIN "Training" t ON t."staffId" = st.id AND t."startDate" BETWEEN ${from} AND ${to}
      WHERE st.category = 'TEACHING' AND st.status IN ('ACTIVE', 'ON_LEAVE') AND s."isActive" AND (${lga}::text IS NULL OR s.lga = ${lga}) AND (${schoolId}::uuid IS NULL OR s.id = ${schoolId}::uuid)
      GROUP BY st.id`;
    const hs = hours.map((h) => n(h.hours));
    const bucket = (lo: number, hi: number) => hs.filter((h) => h >= lo && h <= hi).length;

    // Subject shortages: pupils taking each subject against teachers qualified to teach it.
    const sid = session?.id ?? '00000000-0000-0000-0000-000000000000';
    const demand = await this.prisma.$queryRaw<{ code: string; pupils: bigint; assigned: bigint; unassigned: bigint }[]>`
      SELECT cs."subjectCode" AS code, count(cp.id) AS pupils, count(DISTINCT cs."teacherId") AS assigned,
        count(DISTINCT cs.id) FILTER (WHERE cs."teacherId" IS NULL) AS unassigned
      FROM "ClassSubject" cs JOIN "ClassArm" ca ON ca.id = cs."classArmId" JOIN "School" s ON s.id = ca."schoolId"
      LEFT JOIN "ClassPlacement" cp ON cp."classArmId" = ca.id
      WHERE ca."sessionId" = ${sid}::uuid AND s."isActive" AND (${lga}::text IS NULL OR s.lga = ${lga}) AND (${schoolId}::uuid IS NULL OR s.id = ${schoolId}::uuid)
      GROUP BY cs."subjectCode"`;
    const supply = await this.prisma.$queryRaw<{ code: string; teachers: bigint }[]>`
      SELECT code, count(*) AS teachers FROM (
        SELECT unnest(st.subjects) AS code FROM "Staff" st JOIN "School" s ON s.id = st."currentSchoolId"
        WHERE st.category = 'TEACHING' AND st.status = 'ACTIVE' AND s."isActive" AND (${lga}::text IS NULL OR s.lga = ${lga}) AND (${schoolId}::uuid IS NULL OR s.id = ${schoolId}::uuid)
      ) x GROUP BY code`;
    const teachersFor = new Map(supply.map((x) => [x.code, n(x.teachers)]));
    const subjects = demand
      .map((d) => {
        const pupils = n(d.pupils);
        const needed = Math.ceil(pupils / PUPILS_PER_SUBJECT_TEACHER);
        const teachers = teachersFor.get(d.code) ?? 0;
        return { code: d.code, name: subjectName(d.code), pupils, teachers, needed, shortfall: Math.max(0, needed - teachers), pupilsPerTeacher: teachers ? Math.round(pupils / teachers) : null, classesWithoutTeacher: n(d.unassigned) };
      })
      .sort((a, b) => b.shortfall - a.shortfall || a.name.localeCompare(b.name));

    return {
      date: isoDate(date),
      attendance: { ...total, presentRate: total.marked ? Math.round(((total.present + total.late) / total.marked) * 1000) / 10 : null, byLga: lga || schoolId ? [] : byLga },
      training: {
        targetHours: TRAINING_TARGET_HOURS, session: session?.name ?? null, teachers: hs.length,
        metTarget: hs.filter((h) => h >= TRAINING_TARGET_HOURS).length,
        averageHours: hs.length ? Math.round((hs.reduce((a, b) => a + b, 0) / hs.length) * 10) / 10 : null,
        buckets: [{ label: 'None', count: bucket(0, 0) }, { label: '1 to 19 hours', count: bucket(1, 19) }, { label: '20 to 39 hours', count: bucket(20, 39) }, { label: '40 hours or more', count: bucket(40, Infinity) }],
      },
      shortages: { pupilsPerTeacher: PUPILS_PER_SUBJECT_TEACHER, subjects },
    };
  }
}
