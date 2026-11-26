import { Module } from '@nestjs/common';
import { SmsModule } from '../sms/sms.module';
import { StudentsModule } from '../students/students.module';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';

@Module({ imports: [StudentsModule, SmsModule], controllers: [AttendanceController], providers: [AttendanceService], exports: [AttendanceService] })
export class AttendanceModule {}
