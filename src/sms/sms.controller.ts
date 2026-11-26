import { BadRequestException, Body, Controller, Get, NotFoundException, Patch, Post, Query, Req } from '@nestjs/common';
import { Prisma, Role, SmsStatus } from '@prisma/client';
import { IsBoolean, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth-user';
import { isoDate, parseDate, today } from '../common/dates';
import { CurrentUser, Roles } from '../common/decorators';
import { normalisePhone } from '../common/identity';
import { MINISTRY_ROLES } from '../common/roles';
import { PrismaService } from '../prisma/prisma.service';
import { SmsService } from './sms.service';

class SettingsDto {
  @IsBoolean()
  absenceSms: boolean;

  /** Ministry administrators may set it for any school. */
  @IsOptional()
  @IsUUID()
  schoolId?: string;
}

class TestDto {
  @IsString()
  @MaxLength(20)
  phone: string;
}

/** Absence texts to parents: the message log, each school's on/off setting, and a test send for the Ministry. */
@Controller('sms')
@Roles(...MINISTRY_ROLES, Role.SCHOOL_ADMIN)
export class SmsController {
  constructor(private readonly prisma: PrismaService, private readonly sms: SmsService, private readonly audit: AuditService) {}

  private scope(me: AuthUser, schoolId?: string): Prisma.SmsMessageWhereInput {
    if (me.role === Role.SCHOOL_ADMIN) return { schoolId: me.schoolId! };
    return schoolId ? { schoolId } : {};
  }

  @Get()
  async list(@CurrentUser() me: AuthUser, @Query('date') date?: string, @Query('status') status?: string, @Query('schoolId') schoolId?: string) {
    const where: Prisma.SmsMessageWhereInput = { ...this.scope(me, schoolId) };
    if (date) where.createdAt = { gte: parseDate(date, 'Date'), lt: new Date(parseDate(date, 'Date').getTime() + 86_400_000) };
    if (status) {
      if (!(status in SmsStatus)) throw new BadRequestException('Unknown status.');
      where.status = status as SmsStatus;
    }
    const rows = await this.prisma.smsMessage.findMany({ where, orderBy: { createdAt: 'desc' }, take: 300 });
    const ids = (k: 'studentId' | 'parentId' | 'schoolId') => [...new Set(rows.map((r) => r[k]).filter(Boolean))] as string[];
    const [students, parents, schools] = await Promise.all([
      this.prisma.student.findMany({ where: { id: { in: ids('studentId') } }, select: { id: true, surname: true, firstName: true } }),
      this.prisma.user.findMany({ where: { id: { in: ids('parentId') } }, select: { id: true, fullName: true } }),
      this.prisma.school.findMany({ where: { id: { in: ids('schoolId') } }, select: { id: true, name: true } }),
    ]);
    const s = new Map(students.map((x) => [x.id, `${x.surname} ${x.firstName}`]));
    const p = new Map(parents.map((x) => [x.id, x.fullName]));
    const sc = new Map(schools.map((x) => [x.id, x.name]));
    return rows.map((r) => ({
      id: r.id, kind: r.kind, to: r.to, body: r.body, status: r.status, provider: r.provider, error: r.error, attempts: r.attempts,
      date: isoDate(r.date), createdAt: r.createdAt, sendAfter: r.sendAfter, sentAt: r.sentAt, cost: r.cost,
      student: r.studentId ? s.get(r.studentId) ?? null : null,
      parent: r.parentId ? p.get(r.parentId) ?? null : null,
      school: r.schoolId ? sc.get(r.schoolId) ?? null : null,
    }));
  }

  /** Today's counts, the school's setting, and (for the Ministry) which provider is sending. */
  @Get('summary')
  async summary(@CurrentUser() me: AuthUser) {
    const start = new Date(today().getTime() - 3_600_000); // Midnight in Lagos, in UTC.
    const groups = await this.prisma.smsMessage.groupBy({ by: ['status'], where: { ...this.scope(me), createdAt: { gte: start } }, _count: true });
    const counts = Object.fromEntries(Object.values(SmsStatus).map((k) => [k, 0])) as Record<SmsStatus, number>;
    groups.forEach((g) => (counts[g.status] = g._count));
    const school = me.role === Role.SCHOOL_ADMIN ? await this.prisma.school.findUnique({ where: { id: me.schoolId! }, select: { absenceSms: true } }) : null;
    const ministry = me.role !== Role.SCHOOL_ADMIN;
    return {
      today: counts,
      absenceSms: school?.absenceSms ?? null,
      delayMinutes: this.sms.delayMinutes,
      provider: this.sms.provider.name,
      sending: this.sms.provider.name !== 'log',
      balance: ministry && me.role === Role.MINISTRY_ADMIN && this.sms.provider.balance ? await this.sms.provider.balance() : null,
      schoolsOff: ministry ? await this.prisma.school.count({ where: { isActive: true, absenceSms: false } }) : null,
    };
  }

  @Patch('settings')
  @Roles(Role.MINISTRY_ADMIN, Role.SCHOOL_ADMIN)
  async settings(@CurrentUser() me: AuthUser, @Body() dto: SettingsDto, @Req() req: Request) {
    const schoolId = me.role === Role.SCHOOL_ADMIN ? me.schoolId! : dto.schoolId;
    if (!schoolId) throw new BadRequestException('Choose a school.');
    const school = await this.prisma.school.findUnique({ where: { id: schoolId } });
    if (!school) throw new NotFoundException('School not found.');
    await this.prisma.school.update({ where: { id: schoolId }, data: { absenceSms: dto.absenceSms } });
    if (!dto.absenceSms) {
      await this.prisma.smsMessage.updateMany({ where: { schoolId, status: SmsStatus.QUEUED }, data: { status: SmsStatus.CANCELLED, error: 'The school has switched absence texts off.' } });
    }
    await this.audit.record({ actorId: me.id, action: dto.absenceSms ? 'sms.absence_on' : 'sms.absence_off', targetType: 'school', targetId: schoolId, schoolId, ip: req.ip });
    return { absenceSms: dto.absenceSms };
  }

  /** Sends one test message straight away, to check the provider account and sender ID. */
  @Post('test')
  @Roles(Role.MINISTRY_ADMIN)
  async test(@CurrentUser() me: AuthUser, @Body() dto: TestDto, @Req() req: Request) {
    const to = normalisePhone(dto.phone);
    if (!to) throw new BadRequestException('Enter a valid Nigerian phone number.');
    const body = 'Test message from Osun EduOS. Absence texts to parents are set up correctly.';
    const r = await this.sms.provider.send(to, body);
    await this.prisma.smsMessage.create({
      data: {
        kind: 'TEST', to, body, status: r.ok ? SmsStatus.SENT : SmsStatus.FAILED, sendAfter: new Date(), attempts: 1,
        provider: this.sms.provider.name, providerId: r.providerId, cost: r.cost, error: r.error, sentAt: r.ok ? new Date() : null,
      },
    });
    await this.audit.record({ actorId: me.id, action: 'sms.test', targetType: 'sms', targetId: to, meta: { ok: r.ok }, ip: req.ip });
    return { ok: r.ok, provider: this.sms.provider.name, error: r.error ?? null };
  }
}
