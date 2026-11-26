import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { AuthUser } from '../common/auth-user';
import { CurrentUser } from '../common/decorators';
import { NotificationsService } from './notifications.service';

class ReadDto {
  /** Leave out to mark everything read. */
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID('4', { each: true }) ids?: string[];
}

class DeviceDto {
  @IsString() @MinLength(20) @MaxLength(4096) token: string;
  @IsIn(['android', 'ios']) platform: string;
}

/** Everyone's own inbox, and the phones that receive their push notifications. */
@Controller()
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('notifications')
  inbox(@CurrentUser() me: AuthUser) {
    return this.notifications.inbox(me.id);
  }

  @Get('notifications/unread-count')
  async unread(@CurrentUser() me: AuthUser) {
    return { unread: await this.notifications.unreadCount(me.id) };
  }

  @Post('notifications/read')
  read(@CurrentUser() me: AuthUser, @Body() dto: ReadDto) {
    return this.notifications.markRead(me.id, dto.ids);
  }

  @Post('devices')
  register(@CurrentUser() me: AuthUser, @Body() dto: DeviceDto) {
    return this.notifications.registerDevice(me.id, dto.token, dto.platform);
  }

  @Delete('devices/:token')
  remove(@CurrentUser() me: AuthUser, @Param('token') token: string) {
    return this.notifications.removeDevice(me.id, token);
  }
}
