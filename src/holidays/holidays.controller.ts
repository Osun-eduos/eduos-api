import { BadRequestException, Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
import { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth-user';
import { isoDate, parseDate } from '../common/dates';
import { CurrentUser, Roles } from '../common/decorators';
import { nationalHolidays } from '../common/holidays';
import { PrismaService } from '../prisma/prisma.service';

class CreateHolidayDto {
  @IsString()
  @Length(3, 80, { message: 'Give the holiday a name (3 to 80 characters).' })
  name: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Start date must be YYYY-MM-DD.' })
  startDate: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'End date must be YYYY-MM-DD.' })
  endDate?: string;
}

class NationalDto {
  @IsUUID('4', { message: 'Choose a session.' })
  sessionId: string;
}

const view = (h: { id: string; name: string; startDate: Date; endDate: Date }) => ({ id: h.id, name: h.name, startDate: isoDate(h.startDate), endDate: isoDate(h.endDate) });

/** State-wide holidays and other non-school days. Everyone can read them; the Ministry administrator sets them. */
@Controller('holidays')
export class HolidaysController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /** Holidays overlapping a session (the current one by default). */
  @Get()
  async list(@Query('sessionId') sessionId?: string) {
    const session = sessionId
      ? await this.prisma.academicSession.findUnique({ where: { id: sessionId } })
      : await this.prisma.academicSession.findFirst({ where: { isCurrent: true } });
    if (!session) return [];
    const rows = await this.prisma.holiday.findMany({
      where: { startDate: { lte: session.endDate }, endDate: { gte: session.startDate } },
      orderBy: { startDate: 'asc' },
    });
    return rows.map(view);
  }

  @Post()
  @Roles(Role.MINISTRY_ADMIN)
  async create(@CurrentUser() me: AuthUser, @Body() dto: CreateHolidayDto, @Req() req: Request) {
    const start = parseDate(dto.startDate, 'Start date');
    const end = dto.endDate ? parseDate(dto.endDate, 'End date') : start;
    if (end < start) throw new BadRequestException('The holiday must end on or after the day it starts.');
    if ((end.getTime() - start.getTime()) / 86_400_000 > 60) throw new BadRequestException('A holiday can be at most 60 days. Use the term dates for school breaks.');
    const name = dto.name.trim();
    if (await this.prisma.holiday.findUnique({ where: { startDate_name: { startDate: start, name } } })) throw new ConflictException('That holiday is already set.');
    const h = await this.prisma.holiday.create({ data: { name, startDate: start, endDate: end, createdById: me.id } });
    const registers = await this.prisma.attendanceRegister.count({ where: { date: { gte: start, lte: end } } });
    await this.audit.record({ actorId: me.id, action: 'holiday.created', targetType: 'holiday', targetId: h.id, meta: { name, startDate: isoDate(start), endDate: isoDate(end) }, ip: req.ip });
    return { ...view(h), registersAlreadyTaken: registers };
  }

  /** Adds the fixed-date federal holidays (and Good Friday and Easter Monday) that fall within a session. Skips any already set. */
  @Post('national')
  @Roles(Role.MINISTRY_ADMIN)
  async national(@CurrentUser() me: AuthUser, @Body() dto: NationalDto, @Req() req: Request) {
    const session = await this.prisma.academicSession.findUnique({ where: { id: dto.sessionId } });
    if (!session) throw new NotFoundException('Session not found.');
    const added: string[] = [];
    for (const h of nationalHolidays(session.startDate, session.endDate)) {
      const exists = await this.prisma.holiday.findFirst({ where: { startDate: { lte: h.date }, endDate: { gte: h.date } } });
      if (exists) continue;
      await this.prisma.holiday.create({ data: { name: h.name, startDate: h.date, endDate: h.date, createdById: me.id } });
      added.push(`${h.name} (${isoDate(h.date)})`);
    }
    await this.audit.record({ actorId: me.id, action: 'holiday.national_added', targetType: 'session', targetId: session.id, meta: { session: session.name, added: added.length }, ip: req.ip });
    return { added };
  }

  @Delete(':id')
  @Roles(Role.MINISTRY_ADMIN)
  async remove(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    const h = await this.prisma.holiday.findUnique({ where: { id } });
    if (!h) throw new NotFoundException('Holiday not found.');
    await this.prisma.holiday.delete({ where: { id } });
    await this.audit.record({ actorId: me.id, action: 'holiday.removed', targetType: 'holiday', targetId: id, meta: { name: h.name, startDate: isoDate(h.startDate) }, ip: req.ip });
    return { ok: true };
  }
}
