import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { SchoolsController } from './schools.controller';
import { SchoolsService } from './schools.service';

@Module({ imports: [UsersModule], controllers: [SchoolsController], providers: [SchoolsService] })
export class SchoolsModule {}
