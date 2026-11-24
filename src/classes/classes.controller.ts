import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ClassLevel, Role } from '@prisma/client';
import { IsEnum, IsInt, IsOptional, IsUUID, Matches, Max, Min, ValidateIf } from 'class-validator';
import { Request } from 'express';
import { AuthUser } from '../common/auth-user';
import { CurrentUser, Roles } from '../common/decorators';
import { ClassesService } from './classes.service';

class CreateClassDto {
  @IsEnum(ClassLevel)
  level: ClassLevel;

  @Matches(/^[A-Za-z0-9]{1,10}$/, { message: 'Name the arm with letters or numbers, e.g. A, B or Gold.' })
  arm: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  capacity?: number;

  @IsOptional()
  @IsUUID()
  classTeacherId?: string;
}

class UpdateClassDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  capacity?: number;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  classTeacherId?: string | null;
}

@Controller('classes')
export class ClassesController {
  constructor(private readonly classes: ClassesService) {}

  @Get()
  @Roles(Role.MINISTRY_ADMIN, Role.MINISTRY_OFFICER, Role.SCHOOL_ADMIN, Role.TEACHER)
  list(@CurrentUser() me: AuthUser, @Query('schoolId') schoolId?: string, @Query('sessionId') sessionId?: string) {
    return this.classes.list(me, schoolId, sessionId);
  }

  @Get('levels')
  @Roles(Role.MINISTRY_ADMIN, Role.MINISTRY_OFFICER, Role.SCHOOL_ADMIN)
  levels(@CurrentUser() me: AuthUser, @Query('schoolId') schoolId?: string) {
    return this.classes.levels(me, schoolId);
  }

  @Post()
  @Roles(Role.SCHOOL_ADMIN)
  create(@CurrentUser() me: AuthUser, @Body() dto: CreateClassDto, @Req() req: Request) {
    return this.classes.create(me, dto, req.ip ?? null);
  }

  @Patch(':id')
  @Roles(Role.SCHOOL_ADMIN)
  update(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateClassDto, @Req() req: Request) {
    return this.classes.update(me, id, dto, req.ip ?? null);
  }

  @Delete(':id')
  @HttpCode(204)
  @Roles(Role.SCHOOL_ADMIN)
  remove(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.classes.remove(me, id, req.ip ?? null);
  }
}
