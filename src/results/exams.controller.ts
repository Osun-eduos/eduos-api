import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Put, Query, Req } from '@nestjs/common';
import { ClassLevel, Role } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEnum, IsInt, IsOptional, IsString, IsUUID, Matches, Max, Min, ValidateNested } from 'class-validator';
import { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth-user';
import { className, levelLabel, LEVELS_FOR_SCHOOL } from '../common/classes';
import { isoDate, parseDate } from '../common/dates';
import { CurrentUser, Roles } from '../common/decorators';
import { subjectName, subjectsFor, termName } from '../common/results';
import { OVERSIGHT_ROLES } from '../common/roles';
import { seesLga } from '../common/scope';
import { PrismaService } from '../prisma/prisma.service';
import { StudentsService } from '../students/students.service';

class PaperDto {
  @IsString() @Matches(/^[A-Z]{3}$/) subjectCode!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Paper dates must be YYYY-MM-DD.' }) date!: string;
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'Start times are HH:MM, e.g. 09:00.' }) startTime!: string;
  @IsInt() @Min(15) @Max(240) minutes!: number;
}

class SaveTimetableDto {
  @IsEnum(ClassLevel) level!: ClassLevel;
  @IsOptional() @IsUUID() termId?: string;
  @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => PaperDto) papers!: PaperDto[];
}

class TimetableQuery {
  @IsEnum(ClassLevel) level!: ClassLevel;
  @IsOptional() @IsUUID() termId?: string;
  @IsOptional() @IsUUID() schoolId?: string;
}

const view = (p: { id: string; subjectCode: string; date: Date; startTime: string; minutes: number }) => ({
  id: p.id, subjectCode: p.subjectCode, subject: subjectName(p.subjectCode), date: isoDate(p.date), startTime: p.startTime, minutes: p.minutes,
});

/** Each school's examination timetable, per class level and term. Parents see their child's. */
@Controller('exam-papers')
export class ExamsController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly students: StudentsService) {}

  private async term(termId?: string) {
    const t = termId
      ? await this.prisma.term.findUnique({ where: { id: termId }, include: { session: true } })
      : await this.prisma.term.findFirst({ where: { isCurrent: true }, include: { session: true } });
    if (!t) throw new BadRequestException(termId ? 'Term not found.' : 'The Ministry has not set the current term yet.');
    return t;
  }

  private async load(schoolId: string, level: ClassLevel, termId?: string) {
    const t = await this.term(termId);
    const papers = await this.prisma.examPaper.findMany({ where: { schoolId, termId: t.id, level }, orderBy: [{ date: 'asc' }, { startTime: 'asc' }] });
    return { term: { id: t.id, name: termName(t.number), session: t.session.name, startDate: isoDate(t.startDate), endDate: isoDate(t.endDate) }, level, levelName: levelLabel(level), papers: papers.map(view) };
  }

  @Get()
  @Roles(...OVERSIGHT_ROLES, Role.SCHOOL_ADMIN, Role.TEACHER)
  async get(@CurrentUser() me: AuthUser, @Query() q: TimetableQuery) {
    let schoolId = me.schoolId;
    if (!schoolId) {
      if (!q.schoolId) throw new BadRequestException('Choose a school.');
      const s = await this.prisma.school.findUnique({ where: { id: q.schoolId } });
      if (!s || !seesLga(me, s.lga)) throw new NotFoundException('School not found.');
      schoolId = s.id;
    }
    return this.load(schoolId, q.level, q.termId);
  }

  /** The timetable for a student's class this term: for parents, and anyone who can see the student. */
  @Get('student/:id')
  async forStudent(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.students.assertCanView(me, id);
    const t = await this.term();
    const p = await this.prisma.classPlacement.findUnique({ where: { studentId_sessionId: { studentId: id, sessionId: t.sessionId } }, include: { classArm: true } });
    if (!p) return { term: null, level: null, levelName: null, className: null, papers: [] };
    return { ...(await this.load(p.classArm.schoolId, p.classArm.level, t.id)), className: className(p.classArm.level, p.classArm.arm) };
  }

  /** Replaces the timetable for one class level. */
  @Put()
  @Roles(Role.SCHOOL_ADMIN)
  async save(@CurrentUser() me: AuthUser, @Body() dto: SaveTimetableDto, @Req() req: Request) {
    const school = await this.prisma.school.findUniqueOrThrow({ where: { id: me.schoolId! } });
    if (!LEVELS_FOR_SCHOOL[school.level].includes(dto.level)) throw new ForbiddenException('Your school does not teach that level.');
    const t = await this.term(dto.termId);
    if (t.endDate < new Date(Date.now() - 86_400_000) && !t.isCurrent) throw new BadRequestException('That term has ended.');
    const offered = new Set(subjectsFor(dto.level).map((s) => s.code));
    const seen = new Set<string>();
    for (const p of dto.papers) {
      if (!offered.has(p.subjectCode)) throw new BadRequestException(`${subjectName(p.subjectCode)} is not taught in ${levelLabel(dto.level)}.`);
      if (seen.has(p.subjectCode)) throw new BadRequestException(`${subjectName(p.subjectCode)} is listed twice.`);
      seen.add(p.subjectCode);
      const d = parseDate(p.date, 'Paper date');
      if (d < t.startDate || d > t.endDate) throw new BadRequestException(`${subjectName(p.subjectCode)}: the paper must be within the term (${isoDate(t.startDate)} to ${isoDate(t.endDate)}).`);
      if (d.getUTCDay() === 0) throw new BadRequestException(`${subjectName(p.subjectCode)}: papers cannot be on a Sunday.`);
    }
    // Two papers for the same class cannot overlap.
    const slots = dto.papers.map((p) => {
      const [h, m] = p.startTime.split(':').map(Number);
      return { p, start: h * 60 + m, end: h * 60 + m + p.minutes };
    });
    for (const a of slots) for (const b of slots) {
      if (a !== b && a.p.date === b.p.date && a.start < b.end && b.start < a.end) throw new BadRequestException(`${subjectName(a.p.subjectCode)} and ${subjectName(b.p.subjectCode)} overlap on ${a.p.date}.`);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.examPaper.deleteMany({ where: { schoolId: school.id, termId: t.id, level: dto.level } });
      if (dto.papers.length) {
        await tx.examPaper.createMany({ data: dto.papers.map((p) => ({ schoolId: school.id, termId: t.id, level: dto.level, subjectCode: p.subjectCode, date: parseDate(p.date, 'Paper date'), startTime: p.startTime, minutes: p.minutes })) });
      }
      await this.audit.record({ actorId: me.id, action: 'exams.timetable_saved', targetType: 'school', targetId: school.id, schoolId: school.id, meta: { level: levelLabel(dto.level), term: termName(t.number), papers: dto.papers.length }, ip: req.ip ?? null }, tx);
    });
    return this.load(school.id, dto.level, t.id);
  }
}
