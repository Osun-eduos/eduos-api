import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Request } from 'express';
import { AuthUser } from '../common/auth-user';
import { CurrentUser, Roles } from '../common/decorators';
import { AttendanceService, TEACHER_EDIT_DAYS } from './attendance.service';
import { ClassRangeQuery, DayQuery, RangeQuery, RegisterQuery, SaveRegisterDto } from './dto';

@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Get('rules')
  rules() {
    return { teacherEditDays: TEACHER_EDIT_DAYS, statuses: ['PRESENT', 'LATE', 'ABSENT', 'EXCUSED'] };
  }

  @Get('register')
  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN, Role.MINISTRY_ADMIN, Role.MINISTRY_OFFICER)
  register(@CurrentUser() me: AuthUser, @Query() q: RegisterQuery) {
    return this.attendance.getRegister(me, q.classId, q.date);
  }

  @Put('register')
  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN)
  save(@CurrentUser() me: AuthUser, @Body() dto: SaveRegisterDto, @Req() req: Request) {
    return this.attendance.saveRegister(me, dto, req.ip ?? null);
  }

  @Get('day')
  @Roles(Role.SCHOOL_ADMIN, Role.MINISTRY_ADMIN, Role.MINISTRY_OFFICER)
  day(@CurrentUser() me: AuthUser, @Query() q: DayQuery) {
    return this.attendance.day(me, q.date, q.schoolId);
  }

  @Get('class')
  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN, Role.MINISTRY_ADMIN, Role.MINISTRY_OFFICER)
  classSummary(@CurrentUser() me: AuthUser, @Query() q: ClassRangeQuery) {
    return this.attendance.classSummary(me, q.classId, q.from, q.to);
  }

  @Get('students/:id')
  student(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: RangeQuery) {
    return this.attendance.student(me, id, q.from, q.to);
  }
}
