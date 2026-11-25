import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Prisma, Role, SssGrading, Term } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth-user';
import { isoDate, parseDate } from '../common/dates';
import { CurrentUser, Roles } from '../common/decorators';
import { Component, componentsProblem, DEFAULT_COMPONENTS, termName } from '../common/results';
import { PrismaService } from '../prisma/prisma.service';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

class ComponentDto {
  @IsString() @Matches(/^[A-Z][A-Z0-9]{0,7}$/) key!: string;
  @IsString() @MaxLength(20) label!: string;
  @IsInt() @Min(1) @Max(100) max!: number;
}

class CreateTermDto {
  @IsOptional() @IsUUID() sessionId?: string;
  @IsIn([1, 2, 3]) number!: number;
  @Matches(DATE, { message: 'Start date must be YYYY-MM-DD.' }) startDate!: string;
  @Matches(DATE, { message: 'End date must be YYYY-MM-DD.' }) endDate!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(6) @ValidateNested({ each: true }) @Type(() => ComponentDto) components?: ComponentDto[];
  @IsOptional() @IsBoolean() showPositions?: boolean;
  @IsOptional() @IsEnum(SssGrading, { message: 'Senior secondary grading must be WAEC or BASIC.' }) sssGrading?: SssGrading;
}

class UpdateTermDto {
  @IsOptional() @Matches(DATE) startDate?: string;
  @IsOptional() @Matches(DATE) endDate?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(6) @ValidateNested({ each: true }) @Type(() => ComponentDto) components?: ComponentDto[];
  @IsOptional() @IsBoolean() showPositions?: boolean;
  @IsOptional() @IsEnum(SssGrading, { message: 'Senior secondary grading must be WAEC or BASIC.' }) sssGrading?: SssGrading;
}

class TermsQuery {
  @IsOptional() @IsUUID() sessionId?: string;
}

type TermWithSession = Term & { session: { id: string; name: string } };

export const termView = (t: TermWithSession) => ({
  id: t.id, number: t.number, name: termName(t.number), session: { id: t.session.id, name: t.session.name },
  startDate: isoDate(t.startDate), endDate: isoDate(t.endDate), isCurrent: t.isCurrent,
  components: t.components as unknown as Component[], showPositions: t.showPositions, sssGrading: t.sssGrading,
});

@Controller('terms')
export class TermsController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  @Get()
  async list(@Query() q: TermsQuery) {
    const sessionId = q.sessionId ?? (await this.prisma.academicSession.findFirst({ where: { isCurrent: true } }))?.id;
    if (!sessionId) return [];
    const rows = await this.prisma.term.findMany({ where: { sessionId }, include: { session: true }, orderBy: { number: 'asc' } });
    return rows.map(termView);
  }

  @Get('current')
  async current() {
    const t = await this.prisma.term.findFirst({ where: { isCurrent: true }, include: { session: true } });
    return t ? termView(t) : null;
  }

  private async checkDates(sessionId: string, number: number, start: Date, end: Date, excludeId?: string) {
    const session = await this.prisma.academicSession.findUniqueOrThrow({ where: { id: sessionId } });
    if (end <= start) throw new BadRequestException('The term must end after it starts.');
    if (start < session.startDate || end > session.endDate) {
      throw new BadRequestException(`The term must fall within the ${session.name} session (${isoDate(session.startDate)} to ${isoDate(session.endDate)}).`);
    }
    const others = await this.prisma.term.findMany({ where: { sessionId, id: excludeId ? { not: excludeId } : undefined } });
    for (const o of others) {
      if (start <= o.endDate && end >= o.startDate) throw new BadRequestException(`The dates overlap the ${termName(o.number).toLowerCase()}.`);
      if ((o.number < number && o.startDate > start) || (o.number > number && o.startDate < start)) {
        throw new BadRequestException('Terms must be in order: first, second, then third.');
      }
    }
  }

  @Post()
  @Roles(Role.MINISTRY_ADMIN)
  async create(@CurrentUser() me: AuthUser, @Body() dto: CreateTermDto, @Req() req: Request) {
    const session = dto.sessionId
      ? await this.prisma.academicSession.findUnique({ where: { id: dto.sessionId } })
      : await this.prisma.academicSession.findFirst({ where: { isCurrent: true } });
    if (!session) throw new BadRequestException('Open an academic session first.');
    const components = dto.components ?? DEFAULT_COMPONENTS;
    const problem = componentsProblem(components);
    if (problem) throw new BadRequestException(problem);
    const start = parseDate(dto.startDate, 'Start date');
    const end = parseDate(dto.endDate, 'End date');
    await this.checkDates(session.id, dto.number, start, end);
    if (await this.prisma.term.findUnique({ where: { sessionId_number: { sessionId: session.id, number: dto.number } } })) {
      throw new ConflictException(`The ${termName(dto.number).toLowerCase()} of ${session.name} already exists.`);
    }
    const first = session.isCurrent && !(await this.prisma.term.count({ where: { isCurrent: true } }));
    const t = await this.prisma.term.create({
      data: {
        sessionId: session.id, number: dto.number, startDate: start, endDate: end, isCurrent: first,
        components: components as unknown as Prisma.InputJsonValue, showPositions: dto.showPositions ?? true, sssGrading: dto.sssGrading ?? SssGrading.WAEC,
      },
      include: { session: true },
    });
    await this.audit.record({ actorId: me.id, action: 'term.created', targetType: 'term', targetId: t.id, meta: { session: session.name, term: termName(t.number) }, ip: req.ip ?? null });
    return termView(t);
  }

  @Patch(':id')
  @Roles(Role.MINISTRY_ADMIN)
  async update(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTermDto, @Req() req: Request) {
    const t = await this.prisma.term.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Term not found.');
    const data: Prisma.TermUpdateInput = {};
    if (dto.startDate || dto.endDate) {
      const start = dto.startDate ? parseDate(dto.startDate, 'Start date') : t.startDate;
      const end = dto.endDate ? parseDate(dto.endDate, 'End date') : t.endDate;
      await this.checkDates(t.sessionId, t.number, start, end, t.id);
      Object.assign(data, { startDate: start, endDate: end });
    }
    if (dto.components) {
      const problem = componentsProblem(dto.components);
      if (problem) throw new BadRequestException(problem);
      if (await this.prisma.score.count({ where: { sheet: { termId: id } } })) {
        throw new BadRequestException('Scores have already been entered for this term, so the score split cannot change.');
      }
      data.components = dto.components as unknown as Prisma.InputJsonValue;
    }
    if (dto.showPositions !== undefined) data.showPositions = dto.showPositions;
    if (dto.sssGrading && dto.sssGrading !== t.sssGrading) {
      const released = await this.prisma.classResult.count({ where: { termId: id, classArm: { level: { in: ['SSS_1', 'SSS_2', 'SSS_3'] } } } });
      if (released) throw new BadRequestException('Senior secondary results have already been released for this term, so their grading scale cannot change.');
      data.sssGrading = dto.sssGrading;
    }
    const u = await this.prisma.term.update({ where: { id }, data, include: { session: true } });
    await this.audit.record({ actorId: me.id, action: 'term.updated', targetType: 'term', targetId: id, meta: { term: termName(u.number), session: u.session.name, ...JSON.parse(JSON.stringify(dto)) }, ip: req.ip ?? null });
    return termView(u);
  }

  /** Makes this the current term. Scores are entered and approved in the current term only. */
  @Post(':id/make-current')
  @Roles(Role.MINISTRY_ADMIN)
  async makeCurrent(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    const t = await this.prisma.term.findUnique({ where: { id }, include: { session: true } });
    if (!t) throw new NotFoundException('Term not found.');
    if (!t.session.isCurrent) throw new BadRequestException(`Make ${t.session.name} the current session first.`);
    const u = await this.prisma.$transaction(async (tx) => {
      await tx.term.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } });
      return tx.term.update({ where: { id }, data: { isCurrent: true }, include: { session: true } });
    });
    await this.audit.record({ actorId: me.id, action: 'term.made_current', targetType: 'term', targetId: id, meta: { term: termName(u.number), session: u.session.name }, ip: req.ip ?? null });
    return termView(u);
  }
}
