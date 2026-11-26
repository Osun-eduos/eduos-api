import { BadRequestException, Body, Controller, Get, Post, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth-user';
import { className } from '../common/classes';
import { today } from '../common/dates';
import { CurrentUser, Roles } from '../common/decorators';
import { currentSession } from '../common/session';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { SmsService } from '../sms/sms.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** Notices that also go by SMS are short, so they fit in two text messages. */
export const SMS_NOTICE_MAX = 240;
/** Texted notices a school may send in a day, to keep SMS costs predictable. */
export const SMS_NOTICES_PER_DAY = 3;

class NoticeDto {
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(80) title: string;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(1000) body: string;
  /** Leave out for every parent in the school. */
  @IsOptional() @IsUUID() classArmId?: string;
  @IsOptional() @IsBoolean() sms?: boolean;
}

/** Messages from a school to its parents: in their inbox, and by text if the school chooses. */
@Controller('notices')
@Roles(Role.SCHOOL_ADMIN)
export class NoticesController {
  constructor(private readonly prisma: PrismaService, private readonly notifications: NotificationsService, private readonly sms: SmsService, private readonly audit: AuditService) {}

  @Get()
  async list(@CurrentUser() me: AuthUser) {
    const rows = await this.prisma.notice.findMany({ where: { schoolId: me.schoolId! }, orderBy: { createdAt: 'desc' }, take: 100 });
    const classes = new Map((await this.prisma.classArm.findMany({ where: { id: { in: rows.map((r) => r.classArmId).filter(Boolean) as string[] } } })).map((c) => [c.id, className(c.level, c.arm)]));
    const sentBy = new Map((await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.sentById) } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    return rows.map((r) => ({ id: r.id, title: r.title, body: r.body, sms: r.sms, recipients: r.recipients, audience: r.classArmId ? classes.get(r.classArmId) ?? 'One class' : 'All parents', sentBy: sentBy.get(r.sentById) ?? null, createdAt: r.createdAt }));
  }

  @Post()
  async send(@CurrentUser() me: AuthUser, @Body() dto: NoticeDto, @Req() req: Request) {
    const schoolId = me.schoolId!;
    const school = await this.prisma.school.findUniqueOrThrow({ where: { id: schoolId } });
    let audience = 'All parents';
    let studentFilter;
    if (dto.classArmId) {
      const session = await currentSession(this.prisma);
      const c = await this.prisma.classArm.findUnique({ where: { id: dto.classArmId } });
      if (!c || c.schoolId !== schoolId || c.sessionId !== session?.id) throw new BadRequestException('Choose a class from your school for the current session.');
      audience = className(c.level, c.arm);
      studentFilter = { placements: { some: { classArmId: c.id } } };
    }
    if (dto.sms) {
      if (dto.title.length + dto.body.length + 2 > SMS_NOTICE_MAX) throw new BadRequestException(`A notice sent by text can be at most ${SMS_NOTICE_MAX} characters, title included. Shorten it or send it to the inbox only.`);
      const start = new Date(today().getTime() - 3_600_000);
      const sent = await this.prisma.notice.count({ where: { schoolId, sms: true, createdAt: { gte: start } } });
      if (sent >= SMS_NOTICES_PER_DAY) throw new BadRequestException(`Your school has sent ${SMS_NOTICES_PER_DAY} notices by text today. Send this one to the inbox only, or text it tomorrow.`);
    }
    const links = await this.prisma.studentGuardian.findMany({
      where: { parent: { isActive: true }, student: { currentSchoolId: schoolId, status: 'ACTIVE', ...studentFilter } },
      select: { parent: { select: { id: true, phone: true } } },
    });
    const parents = [...new Map(links.map((l) => [l.parent.id, l.parent])).values()];
    if (!parents.length) throw new BadRequestException(dto.classArmId ? 'No parents are linked to students in that class yet.' : 'No parents are linked to students at your school yet.');
    const notice = await this.prisma.notice.create({ data: { schoolId, classArmId: dto.classArmId, title: dto.title, body: dto.body, sms: !!dto.sms, recipients: parents.length, sentById: me.id } });
    await this.notifications.notify(parents.map((p) => p.id), { kind: 'NOTICE', title: dto.title, body: `${school.name}: ${dto.body}`, link: '/notifications', key: `notice:${notice.id}` });
    const texts = dto.sms ? parents.filter((p) => p.phone).map((p) => ({ to: p.phone!, parentId: p.id, schoolId, body: `${school.name.slice(0, 40)}: ${dto.title}. ${dto.body}` })) : [];
    if (texts.length) await this.sms.queue('NOTICE', texts);
    await this.audit.record({ actorId: me.id, action: 'notice.sent', targetType: 'notice', targetId: notice.id, schoolId, meta: { audience, recipients: parents.length, texts: texts.length }, ip: req.ip });
    return { id: notice.id, audience, recipients: parents.length, texts: texts.length };
  }
}
