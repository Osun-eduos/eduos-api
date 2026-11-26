import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import { ClassLevel, Role } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { Request, Response } from 'express';
import { AuditService } from '../audit/audit.service';
import { csvFile } from '../indicators/export';
import { RecordsService } from './records.service';
import { AuthUser } from '../common/auth-user';
import { CurrentUser, Public, Roles } from '../common/decorators';
import { Throttle } from '@nestjs/throttler';
import { SUBJECTS } from '../common/results';
import { OVERSIGHT_ROLES } from '../common/roles';
import { AddSubjectDto, ClassTermQuery, ReleaseDto, ReturnDto, SaveRemarksDto, SaveScoresDto, SetTeacherDto, SheetQuery, TermQuery } from './dto';
import { ResultsService } from './results.service';
import { SheetsService } from './sheets.service';
import { SubjectsService } from './subjects.service';

class RecordsQueryDto {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsUUID() sessionId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(3) term?: number;
  @IsOptional() @IsUUID() schoolId?: string;
  @IsOptional() @IsEnum(ClassLevel) level?: ClassLevel;
  @IsOptional() @IsUUID() classId?: string;
  @IsOptional() @Matches(/^[A-Z]{3}$/) subject?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10_000) page?: number;
}

class ApproveAllDto {
  @IsOptional() @IsUUID() classId?: string;
}

class LevelQuery {
  @IsOptional() @IsEnum(ClassLevel) level?: ClassLevel;
}

const STAFF = [...OVERSIGHT_ROLES, Role.SCHOOL_ADMIN, Role.TEACHER];

@Controller()
export class ResultsController {
  constructor(
    private readonly subjects: SubjectsService,
    private readonly sheets: SheetsService,
    private readonly results: ResultsService,
    private readonly records: RecordsService,
    private readonly audit: AuditService,
  ) {}

  // Subjects
  @Get('subjects')
  catalogue(@Query() q: LevelQuery) {
    return q.level ? this.subjects.catalogue(q.level) : SUBJECTS.map((s) => ({ code: s.code, name: s.name }));
  }

  @Get('classes/:id/subjects')
  @Roles(...STAFF)
  classSubjects(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.subjects.list(me, id);
  }

  @Post('classes/:id/subjects')
  @Roles(Role.SCHOOL_ADMIN)
  addSubject(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddSubjectDto, @Req() req: Request) {
    return this.subjects.add(me, id, dto, req.ip ?? null);
  }

  @Post('classes/:id/subjects/core')
  @Roles(Role.SCHOOL_ADMIN)
  addCore(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.subjects.addCore(me, id, req.ip ?? null);
  }

  @Patch('class-subjects/:id')
  @Roles(Role.SCHOOL_ADMIN)
  setTeacher(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetTeacherDto, @Req() req: Request) {
    return this.subjects.setTeacher(me, id, dto.teacherId ?? null, req.ip ?? null);
  }

  @Delete('class-subjects/:id')
  @Roles(Role.SCHOOL_ADMIN)
  @HttpCode(204)
  removeSubject(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.subjects.remove(me, id, req.ip ?? null);
  }

  @Get('my/subjects')
  @Roles(Role.TEACHER)
  mySubjects(@CurrentUser() me: AuthUser) {
    return this.subjects.mine(me);
  }

  // Score sheets
  @Get('scoresheets')
  @Roles(...STAFF)
  sheet(@CurrentUser() me: AuthUser, @Query() q: SheetQuery) {
    return this.sheets.get(me, q.classSubjectId, q.termId);
  }

  @Put('scoresheets')
  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN)
  saveScores(@CurrentUser() me: AuthUser, @Body() dto: SaveScoresDto, @Req() req: Request) {
    return this.sheets.save(me, dto, req.ip ?? null);
  }

  @Post('scoresheets/:id/submit')
  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN)
  @HttpCode(200)
  submit(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.sheets.submit(me, id, req.ip ?? null);
  }

  @Post('scoresheets/approve-all')
  @Roles(Role.SCHOOL_ADMIN)
  @HttpCode(200)
  approveAll(@CurrentUser() me: AuthUser, @Body() dto: ApproveAllDto, @Req() req: Request) {
    return this.sheets.approveAll(me, dto.classId, req.ip ?? null);
  }

  @Post('scoresheets/:id/approve')
  @Roles(Role.SCHOOL_ADMIN)
  @HttpCode(200)
  approve(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.sheets.approve(me, id, req.ip ?? null);
  }

  @Post('scoresheets/:id/return')
  @Roles(Role.SCHOOL_ADMIN)
  @HttpCode(200)
  returnSheet(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReturnDto, @Req() req: Request) {
    return this.sheets.returnSheet(me, id, dto.note, req.ip ?? null);
  }

  // Class results, remarks and release
  @Get('results/class')
  @Roles(...STAFF)
  classResults(@CurrentUser() me: AuthUser, @Query() q: ClassTermQuery) {
    return this.results.classResults(me, q.classId, q.termId);
  }

  @Put('results/remarks')
  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN)
  remarks(@CurrentUser() me: AuthUser, @Body() dto: SaveRemarksDto, @Req() req: Request) {
    return this.results.saveRemarks(me, dto, req.ip ?? null);
  }

  @Post('results/release')
  @Roles(Role.SCHOOL_ADMIN)
  @HttpCode(200)
  release(@CurrentUser() me: AuthUser, @Body() dto: ReleaseDto, @Req() req: Request) {
    return this.results.release(me, dto.classId, req.ip ?? null);
  }

  @Get('results/analysis')
  @Roles(...STAFF)
  analysis(@CurrentUser() me: AuthUser, @Query() q: ClassTermQuery) {
    return this.results.analysis(me, q.classId, q.termId);
  }

  @Get('records/options')
  @Roles(...OVERSIGHT_ROLES, Role.SCHOOL_ADMIN)
  recordOptions(@CurrentUser() me: AuthUser) {
    return this.records.options(me);
  }

  @Get('records')
  @Roles(...OVERSIGHT_ROLES, Role.SCHOOL_ADMIN)
  searchRecords(@CurrentUser() me: AuthUser, @Query() q: RecordsQueryDto) {
    return this.records.search(me, q);
  }

  @Get('records/export')
  @Roles(...OVERSIGHT_ROLES, Role.SCHOOL_ADMIN)
  async exportRecords(@CurrentUser() me: AuthUser, @Query() q: RecordsQueryDto, @Req() req: Request, @Res() res: Response) {
    const rows = await this.records.csv(me, q);
    await this.audit.record({ actorId: me.id, action: 'records.exported', targetType: 'records', targetId: 'csv', schoolId: me.schoolId ?? null, meta: { rows: rows.length - 1, filters: JSON.parse(JSON.stringify(q)) }, ip: req.ip ?? null });
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="exam-records.csv"', 'Cache-Control': 'no-store' });
    res.send(Buffer.from(csvFile(rows), 'utf8'));
  }

  @Get('results/submissions')
  @Roles(...OVERSIGHT_ROLES)
  submissions(@CurrentUser() me: AuthUser, @Query() q: TermQuery) {
    return this.results.submissions(me, q.termId);
  }

  /** Anyone holding a printed report card can check its code; no sign-in needed. */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('verify/:code')
  verify(@Param('code') code: string) {
    if (!/^[A-Za-z0-9-]{6,20}$/.test(code)) throw new NotFoundException('No report card has this code. Check it was typed correctly.');
    return this.results.verify(code);
  }

  @Get('results/summary')
  @Roles(...OVERSIGHT_ROLES, Role.SCHOOL_ADMIN)
  summary(@CurrentUser() me: AuthUser, @Query() q: TermQuery) {
    return this.results.summary(me, q.termId, q.schoolId);
  }

  // Report cards
  @Get('report-cards/:studentId/terms')
  reportCardTerms(@CurrentUser() me: AuthUser, @Param('studentId', ParseUUIDPipe) id: string) {
    return this.results.reportCardTerms(me, id);
  }

  @Get('report-cards/:studentId/progress')
  progress(@CurrentUser() me: AuthUser, @Param('studentId', ParseUUIDPipe) id: string) {
    return this.results.progress(me, id);
  }

  @Get('report-cards/:studentId')
  reportCard(@CurrentUser() me: AuthUser, @Param('studentId', ParseUUIDPipe) id: string, @Query() q: TermQuery) {
    return this.results.reportCard(me, id, q.termId);
  }
}
