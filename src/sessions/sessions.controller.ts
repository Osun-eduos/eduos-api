import { BadRequestException, Body, ConflictException, Controller, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Matches } from 'class-validator';
import { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth-user';
import { parseDate } from '../common/dates';
import { CurrentUser, Roles } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';

class CreateSessionDto {
  @Matches(/^\d{4}\/\d{4}$/, { message: 'Name the session like 2026/2027.' })
  name: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Start date must be YYYY-MM-DD.' })
  startDate: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'End date must be YYYY-MM-DD.' })
  endDate: string;
}

const view = (s: { id: string; name: string; startDate: Date; endDate: Date; isCurrent: boolean }) => ({
  id: s.id, name: s.name, isCurrent: s.isCurrent,
  startDate: s.startDate.toISOString().slice(0, 10), endDate: s.endDate.toISOString().slice(0, 10),
});

@Controller('sessions')
export class SessionsController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  @Get()
  async list() {
    return (await this.prisma.academicSession.findMany({ orderBy: { startDate: 'desc' } })).map(view);
  }

  @Get('current')
  async current() {
    const s = await this.prisma.academicSession.findFirst({ where: { isCurrent: true } });
    return s ? view(s) : null;
  }

  @Post()
  @Roles(Role.MINISTRY_ADMIN)
  async create(@CurrentUser() me: AuthUser, @Body() dto: CreateSessionDto, @Req() req: Request) {
    const [a, b] = dto.name.split('/').map(Number);
    if (b !== a + 1) throw new BadRequestException('A session spans two consecutive years, e.g. 2026/2027.');
    const start = parseDate(dto.startDate, 'Start date');
    const end = parseDate(dto.endDate, 'End date');
    if (end <= start) throw new BadRequestException('The session must end after it starts.');
    if (await this.prisma.academicSession.findUnique({ where: { name: dto.name } })) throw new ConflictException('That session already exists.');
    const first = (await this.prisma.academicSession.count()) === 0;
    const s = await this.prisma.academicSession.create({ data: { name: dto.name, startDate: start, endDate: end, isCurrent: first } });
    await this.audit.record({ actorId: me.id, action: 'session.created', targetType: 'session', targetId: s.id, meta: { name: s.name }, ip: req.ip });
    return view(s);
  }

  /** Makes this the current session. Schools create classes and place students in the current session. */
  @Post(':id/make-current')
  @Roles(Role.MINISTRY_ADMIN)
  async makeCurrent(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    const s = await this.prisma.$transaction(async (tx) => {
      await tx.academicSession.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } });
      // A term belongs to its session, so switching sessions leaves no current term until the Ministry picks one.
      await tx.term.updateMany({ where: { isCurrent: true, sessionId: { not: id } }, data: { isCurrent: false } });
      return tx.academicSession.update({ where: { id }, data: { isCurrent: true } });
    });
    await this.audit.record({ actorId: me.id, action: 'session.made_current', targetType: 'session', targetId: id, meta: { name: s.name }, ip: req.ip });
    return view(s);
  }
}
