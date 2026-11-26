import { Module } from '@nestjs/common';
import { SmsModule } from '../sms/sms.module';
import { NoticesController } from './notices.controller';

@Module({ imports: [SmsModule], controllers: [NoticesController] })
export class NoticesModule {}
