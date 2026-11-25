import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Request } from 'express';
import { AuthUser } from '../common/auth-user';
import { CurrentUser, Roles } from '../common/decorators';
import { EnrolStudentDto, GuardianDto, ListStudentsQuery, PlaceDto, RELATIONSHIPS, UpdateStudentDto, WithdrawDto } from './dto';
import { ImportStudentsDto, IMPORT_MAX_ROWS, StudentImportService } from './import';
import { StudentsService } from './students.service';

@Controller('students')
export class StudentsController {
  constructor(private readonly students: StudentsService, private readonly importer: StudentImportService) {}

  @Get()
  list(@CurrentUser() me: AuthUser, @Query() q: ListStudentsQuery) {
    return this.students.list(me, q);
  }

  @Get('relationships')
  relationships() {
    return RELATIONSHIPS;
  }

  /** Enrols students from a spreadsheet. With dryRun, only checks the rows. Rows with problems are skipped, never half-saved. */
  @Post('import')
  @Roles(Role.SCHOOL_ADMIN)
  @HttpCode(200)
  import(@CurrentUser() me: AuthUser, @Body() dto: ImportStudentsDto, @Req() req: Request) {
    return this.importer.import(me, dto, req.ip ?? null);
  }

  @Get('import/limits')
  @Roles(Role.SCHOOL_ADMIN)
  importLimits() {
    return { maxRows: IMPORT_MAX_ROWS };
  }

  @Get(':id')
  get(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.students.get(me, id);
  }

  @Post()
  @Roles(Role.SCHOOL_ADMIN)
  enrol(@CurrentUser() me: AuthUser, @Body() dto: EnrolStudentDto, @Req() req: Request) {
    return this.students.enrol(me, dto, req.ip ?? null);
  }

  @Patch(':id')
  @Roles(Role.SCHOOL_ADMIN)
  update(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateStudentDto, @Req() req: Request) {
    return this.students.update(me, id, dto, req.ip ?? null);
  }

  @Post(':id/placement')
  @Roles(Role.SCHOOL_ADMIN)
  place(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PlaceDto, @Req() req: Request) {
    return this.students.place(me, id, dto.classArmId, req.ip ?? null);
  }

  @Post(':id/guardians')
  @Roles(Role.SCHOOL_ADMIN)
  addGuardian(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: GuardianDto, @Req() req: Request) {
    return this.students.linkGuardian(me, id, dto, req.ip ?? null);
  }

  @Delete(':id/guardians/:parentId')
  @Roles(Role.SCHOOL_ADMIN)
  removeGuardian(
    @CurrentUser() me: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('parentId', ParseUUIDPipe) parentId: string,
    @Req() req: Request,
  ) {
    return this.students.unlinkGuardian(me, id, parentId, req.ip ?? null);
  }

  @Post(':id/withdraw')
  @Roles(Role.SCHOOL_ADMIN)
  withdraw(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: WithdrawDto, @Req() req: Request) {
    return this.students.withdraw(me, id, dto, req.ip ?? null);
  }
}
