import { Module } from '@nestjs/common';
import { MyController } from '../my/my.controller';
import { UsersModule } from '../users/users.module';
import { StudentsController } from './students.controller';
import { StudentImportService } from './import';
import { StudentsService } from './students.service';

@Module({ imports: [UsersModule], controllers: [StudentsController, MyController], providers: [StudentsService, StudentImportService], exports: [StudentsService] })
export class StudentsModule {}
