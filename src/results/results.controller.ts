import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ClassLevel, Role } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';
import { Request } from 'express';
import { AuthUser } from '../common/auth-user';
import { CurrentUser, Roles } from '../common/decorators';
import { CREDIT_MARK, GRADING, PASS_MARK, SUBJECTS } from '../common/results';
import { AddSubjectDto, ClassTermQuery, ReleaseDto, ReturnDto, SaveRemarksDto, SaveScoresDto, SetTeacherDto, SheetQuery, TermQuery } from './dto';
import { ResultsService } from './results.service';
import { SheetsService } from './sheets.service';
import { SubjectsService } from './subjects.service';

class LevelQuery {
  @IsOptional() @IsEnum(ClassLevel) level?: ClassLevel;
}

const STAFF = [Role.MINISTRY_ADMIN, Role.MINISTRY_OFFICER, Role.SCHOOL_ADMIN, Role.TEACHER];

@Controller()
export class ResultsController {
  constructor(
    private readonly subjects: SubjectsService,
    private readonly sheets: SheetsService,
    private readonly results: ResultsService,
  ) {}

  // Subjects
  @Get('subjects')
  catalogue(@Query() q: LevelQuery) {
    return q.level ? this.subjects.catalogue(q.level) : SUBJECTS.map((s) => ({ code: s.code, name: s.name }));
  }

  @Get('grading')
  grading() {
    return { scales: GRADING, passMark: PASS_MARK, creditMark: CREDIT_MARK };
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

  @Get('results/summary')
  @Roles(Role.MINISTRY_ADMIN, Role.MINISTRY_OFFICER, Role.SCHOOL_ADMIN)
  summary(@CurrentUser() me: AuthUser, @Query() q: TermQuery) {
    return this.results.summary(me, q.termId, q.schoolId);
  }

  // Report cards
  @Get('report-cards/:studentId/terms')
  reportCardTerms(@CurrentUser() me: AuthUser, @Param('studentId', ParseUUIDPipe) id: string) {
    return this.results.reportCardTerms(me, id);
  }

  @Get('report-cards/:studentId')
  reportCard(@CurrentUser() me: AuthUser, @Param('studentId', ParseUUIDPipe) id: string, @Query() q: TermQuery) {
    return this.results.reportCard(me, id, q.termId);
  }
}
