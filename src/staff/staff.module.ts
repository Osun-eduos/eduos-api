import { Module } from '@nestjs/common';
import { StaffController } from './staff.controller';
import { StaffAttendanceController } from './staff-attendance.controller';
import { StaffService } from './staff.service';

@Module({ controllers: [StaffAttendanceController, StaffController], providers: [StaffService], exports: [StaffService] })
export class StaffModule {}
