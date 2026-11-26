import { BadRequestException, Body, ConflictException, Controller, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, Matches, Max, Min, ValidateNested } from 'class-validator';
import { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth-user';
import { addDays, isoDate, parseDate } from '../common/dates';
import { DEFAULT_COMPONENTS } from '../common/results';
import { CurrentUser, Roles } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';

class TermPlanDto {
  @IsArray() @ArrayMinSize(3) @ArrayMaxSize(3) @IsInt({ each: true }) @Min(8, { each: true }) @Max(16, { each: true })
  weeks!: number[];

  @IsInt() @Min(1) @Max(8)
  breakWeeks!: number;
}

class CreateSessionDto {
  @Matches(/^\d{4}\/\d{4}$/, { message: 'Name the session like 2026/2027.' })
  name: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Start date must be YYYY-MM-DD.' })
  startDate: string;

  /** Optional when terms are created: the session then ends with the third term. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'End date must be YYYY-MM-DD.' })
  endDate?: string;

  /** Create the three terms too, from the start date: weeks of teaching per term and weeks of holiday between. */
  @IsOptional()
  @ValidateNested()
  @Type(() => TermPlanDto)
  terms?: TermPlanDto;
}

/** Term dates from a start date: each term runs Monday to Friday for its weeks, then the break. */
export function planTerms(start: Date, weeks: number[], breakWeeks: number) {
  const out: { number: number; start: Date; end: Date }[] = [];
  let from = start;
  weeks.forEach((w, i) => {
    const end = addDays(from, w * 7 - 3);
    out.push({ number: i + 1, start: from, end });
    from = addDays(end, 3 + breakWeeks * 7);
  });
  return out;
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
    const plan = dto.terms ? planTerms(start, dto.terms.weeks, dto.terms.breakWeeks) : null;
    if (!dto.endDate && !plan) throw new BadRequestException('Give an end date, or the weeks for each term.');
    const end = dto.endDate ? parseDate(dto.endDate, 'End date') : plan![2].end;
    if (end <= start) throw new BadRequestException('The session must end after it starts.');
    if (plan && plan[2].end > end) throw new BadRequestException(`The third term would end on ${isoDate(plan[2].end)}, after the session ends.`);
    if (await this.prisma.academicSession.findUnique({ where: { name: dto.name } })) throw new ConflictException('That session already exists.');
    const first = (await this.prisma.academicSession.count()) === 0;
    const s = await this.prisma.$transaction(async (tx) => {
      const created = await tx.academicSession.create({ data: { name: dto.name, startDate: start, endDate: end, isCurrent: first } });
      if (plan) {
        await tx.term.createMany({
          data: plan.map((t) => ({ sessionId: created.id, number: t.number, startDate: t.start, endDate: t.end, isCurrent: first && t.number === 1, components: DEFAULT_COMPONENTS as unknown as Prisma.InputJsonValue })),
        });
      }
      return created;
    });
    await this.audit.record({ actorId: me.id, action: 'session.created', targetType: 'session', targetId: s.id, meta: { name: s.name, terms: plan ? plan.map((t) => `${isoDate(t.start)} to ${isoDate(t.end)}`).join('; ') : null }, ip: req.ip });
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
