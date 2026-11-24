import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { Request } from 'express';
import { AuthUser } from '../common/auth-user';
import { CurrentUser, Roles } from '../common/decorators';
import { TransfersService } from './transfers.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || undefined : value);

class RequestTransferDto {
  @IsUUID() studentId: string;
  @IsUUID() toSchoolId: string;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(200) reason: string;
}

class AcceptTransferDto {
  @IsOptional() @IsUUID() classArmId?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Admission date must be YYYY-MM-DD.' }) admittedOn?: string;
}

class RejectTransferDto {
  @Transform(trim) @IsOptional() @IsString() @MaxLength(300) note?: string;
}

@Controller('transfers')
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  @Get()
  @Roles(Role.MINISTRY_ADMIN, Role.MINISTRY_OFFICER, Role.SCHOOL_ADMIN)
  list(@CurrentUser() me: AuthUser) {
    return this.transfers.list(me);
  }

  @Post()
  @Roles(Role.SCHOOL_ADMIN)
  request(@CurrentUser() me: AuthUser, @Body() dto: RequestTransferDto, @Req() req: Request) {
    return this.transfers.request(me, dto, req.ip ?? null);
  }

  @Post(':id/accept')
  @Roles(Role.SCHOOL_ADMIN)
  accept(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AcceptTransferDto, @Req() req: Request) {
    return this.transfers.accept(me, id, dto, req.ip ?? null);
  }

  @Post(':id/reject')
  @Roles(Role.SCHOOL_ADMIN)
  reject(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectTransferDto, @Req() req: Request) {
    return this.transfers.reject(me, id, dto.note, req.ip ?? null);
  }

  @Post(':id/cancel')
  @Roles(Role.SCHOOL_ADMIN)
  cancel(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.transfers.cancel(me, id, req.ip ?? null);
  }
}
