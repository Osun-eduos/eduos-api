import { BadRequestException, Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { PostingStatus, Role } from '@prisma/client';
import { Request } from 'express';
import { AuthUser } from '../common/auth-user';
import { CurrentUser, Roles } from '../common/decorators';
import { OVERSIGHT_ROLES } from '../common/roles';
import { CreateStaffDto, DecideDto, LinkAccountDto, ListStaffQuery, PostDto, PostingRequestDto, QUALIFICATIONS, QualificationDto, TrainingDto, UpdateStaffDto } from './dto';
import { StaffService } from './staff.service';

const EDITORS = [Role.MINISTRY_ADMIN, Role.SCHOOL_ADMIN];

@Controller()
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get('staff')
  @Roles(...OVERSIGHT_ROLES, Role.SCHOOL_ADMIN)
  list(@CurrentUser() me: AuthUser, @Query() q: ListStaffQuery) {
    return this.staff.list(me, q);
  }

  @Get('staff/qualification-types')
  qualificationTypes() {
    return QUALIFICATIONS;
  }

  @Get('my/staff-record')
  mine(@CurrentUser() me: AuthUser) {
    return this.staff.mine(me);
  }

  @Get('staff/:id')
  @Roles(...OVERSIGHT_ROLES, Role.SCHOOL_ADMIN)
  get(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.staff.get(me, id);
  }

  @Post('staff')
  @Roles(...EDITORS)
  create(@CurrentUser() me: AuthUser, @Body() dto: CreateStaffDto, @Req() req: Request) {
    return this.staff.create(me, dto, req.ip ?? null);
  }

  @Patch('staff/:id')
  @Roles(...EDITORS)
  update(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateStaffDto, @Req() req: Request) {
    return this.staff.update(me, id, dto, req.ip ?? null);
  }

  @Post('staff/:id/qualifications')
  @Roles(...EDITORS)
  addQualification(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: QualificationDto, @Req() req: Request) {
    return this.staff.addQualification(me, id, dto, req.ip ?? null);
  }

  @Delete('staff/:id/qualifications/:qid')
  @Roles(...EDITORS)
  removeQualification(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('qid', ParseUUIDPipe) qid: string) {
    return this.staff.removeQualification(me, id, qid);
  }

  @Post('staff/:id/trainings')
  @Roles(...EDITORS)
  addTraining(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TrainingDto, @Req() req: Request) {
    return this.staff.addTraining(me, id, dto, req.ip ?? null);
  }

  @Delete('staff/:id/trainings/:tid')
  @Roles(...EDITORS)
  removeTraining(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('tid', ParseUUIDPipe) tid: string) {
    return this.staff.removeTraining(me, id, tid);
  }

  @Patch('staff/:id/account')
  @Roles(...EDITORS)
  link(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: LinkAccountDto, @Req() req: Request) {
    return this.staff.linkAccount(me, id, dto.userId, req.ip ?? null);
  }

  @Post('staff/:id/postings')
  @Roles(Role.MINISTRY_ADMIN)
  post(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PostDto, @Req() req: Request) {
    return this.staff.post(me, id, dto, req.ip ?? null);
  }

  @Get('staff-transfers')
  @Roles(...OVERSIGHT_ROLES, Role.SCHOOL_ADMIN)
  requests(@CurrentUser() me: AuthUser, @Query('status') status?: string) {
    if (status && !(status in PostingStatus)) throw new BadRequestException('Unknown status.');
    return this.staff.listRequests(me, status as PostingStatus | undefined);
  }

  @Post('staff-transfers')
  @Roles(Role.SCHOOL_ADMIN)
  request(@CurrentUser() me: AuthUser, @Body() dto: PostingRequestDto, @Req() req: Request) {
    return this.staff.request(me, dto, req.ip ?? null);
  }

  @Post('staff-transfers/:id/approve')
  @Roles(Role.MINISTRY_ADMIN)
  approve(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DecideDto, @Req() req: Request) {
    return this.staff.decide(me, id, true, dto.note, req.ip ?? null);
  }

  @Post('staff-transfers/:id/reject')
  @Roles(Role.MINISTRY_ADMIN)
  reject(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DecideDto, @Req() req: Request) {
    return this.staff.decide(me, id, false, dto.note, req.ip ?? null);
  }

  @Post('staff-transfers/:id/cancel')
  @Roles(Role.SCHOOL_ADMIN)
  cancel(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.staff.cancel(me, id, req.ip ?? null);
  }
}
