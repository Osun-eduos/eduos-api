import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { loadSigningKeys } from './common/jwt-keys';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AttendanceModule } from './attendance/attendance.module';
import { AuditModule } from './audit/audit.module';
import { GradingModule } from './grading/grading.module';
import { ResultsModule } from './results/results.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './common/jwt-auth.guard';
import { RolesGuard } from './common/roles.guard';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { ClassesModule } from './classes/classes.module';
import { SchoolsModule } from './schools/schools.module';
import { HolidaysController } from './holidays/holidays.controller';
import { SessionsController } from './sessions/sessions.controller';
import { StudentsModule } from './students/students.module';
import { TransfersModule } from './transfers/transfers.module';
import { IndicatorsModule } from './indicators/indicators.module';
import { InspectionsModule } from './inspections/inspections.module';
import { NoticesModule } from './notices/notices.module';
import { NotificationsModule } from './notifications/notifications.module';
import { SmsModule } from './sms/sms.module';
import { StaffModule } from './staff/staff.module';
import { StatsController } from './stats/stats.controller';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const keys = loadSigningKeys(config.get<string>('JWT_PRIVATE_KEY'));
        return {
          privateKey: keys.privateKey,
          publicKey: keys.publicKey,
          signOptions: { algorithm: 'ES256', keyid: keys.keyId, expiresIn: config.get('ACCESS_TOKEN_TTL') ?? '15m', issuer: 'eduos-api' },
          verifyOptions: { algorithms: ['ES256'], issuer: 'eduos-api' },
        };
      },
    }),
    PrismaModule,
    AuditModule,
    GradingModule,
    NotificationsModule,
    AuthModule,
    UsersModule,
    SchoolsModule,
    ClassesModule,
    StudentsModule,
    TransfersModule,
    AttendanceModule,
    ResultsModule,
    SmsModule,
    StaffModule,
    InspectionsModule,
    IndicatorsModule,
    NoticesModule,
  ],
  controllers: [HealthController, StatsController, SessionsController, HolidaysController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
