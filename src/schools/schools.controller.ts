import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Request } from 'express';
import { AuthUser } from '../common/auth-user';
import { CurrentUser, Roles } from '../common/decorators';
import { LGA_NAMES } from '../common/lgas';
import { CreateSchoolDto, UpdateSchoolDto } from './dto/school.dto';
import { SchoolsService } from './schools.service';

@Controller('schools')
export class SchoolsController {
  constructor(private readonly schools: SchoolsService) {}

  @Get('lgas')
  lgas() {
    return LGA_NAMES;
  }

  /** Active schools, for choosing where to transfer a student. */
  @Get('directory')
  @Roles(Role.MINISTRY_ADMIN, Role.MINISTRY_OFFICER, Role.SCHOOL_ADMIN)
  directory() {
    return this.schools.directory();
  }

  @Get()
  @Roles(Role.MINISTRY_ADMIN, Role.MINISTRY_OFFICER)
  list(@CurrentUser() me: AuthUser, @Query('lga') lga?: string, @Query('q') q?: string) {
    return this.schools.list(me, lga, q);
  }

  @Get(':id')
  get(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.schools.get(me, id);
  }

  @Post()
  @Roles(Role.MINISTRY_ADMIN)
  create(@CurrentUser() me: AuthUser, @Body() dto: CreateSchoolDto, @Req() req: Request) {
    return this.schools.create(me, dto, req.ip ?? null);
  }

  @Patch(':id')
  @Roles(Role.MINISTRY_ADMIN)
  update(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSchoolDto, @Req() req: Request) {
    return this.schools.update(me, id, dto, req.ip ?? null);
  }
}
