import { Global, Module } from '@nestjs/common';
import { GradingController } from './grading.controller';
import { GradingService } from './grading.service';

@Global()
@Module({ controllers: [GradingController], providers: [GradingService], exports: [GradingService] })
export class GradingModule {}
