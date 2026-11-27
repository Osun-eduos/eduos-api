import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Request } from 'express';
import { AuthUser } from '../common/auth-user';
import { CurrentUser, Roles } from '../common/decorators';
import { CreateUserDto, ListUsersQuery, UpdateUserDto } from './dto/user.dto';
import { UsersService } from './users.service';

@Controller('users')
@Roles(Role.MINISTRY_ADMIN, Role.MINISTRY_OFFICER, Role.SCHOOL_ADMIN)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(@CurrentUser() me: AuthUser, @Query() q: ListUsersQuery) {
    return this.users.list(me, q);
  }

  @Get(':id')
  get(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.get(me, id);
  }

  @Post()
  create(@CurrentUser() me: AuthUser, @Body() dto: CreateUserDto, @Req() req: Request) {
    return this.users.create(me, dto, req.ip ?? null);
  }

  @Patch(':id')
  update(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto, @Req() req: Request) {
    return this.users.update(me, id, dto, req.ip ?? null);
  }

  @Post(':id/reset-two-step')
  resetTwoStep(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.users.resetTwoStep(me, id, req.ip ?? null);
  }

  @Post(':id/reset-password')
  reset(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.users.resetPassword(me, id, req.ip ?? null);
  }
}
