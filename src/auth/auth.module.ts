import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TwoStepService } from './two-step/two-step.service';

@Module({ controllers: [AuthController], providers: [AuthService, TwoStepService], exports: [AuthService] })
export class AuthModule {}
