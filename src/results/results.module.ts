import { Module } from '@nestjs/common';
import { SmsModule } from '../sms/sms.module';
import { StudentsModule } from '../students/students.module';
import { ResultsController } from './results.controller';
import { RecordsService } from './records.service';
import { ResultsService } from './results.service';
import { SheetsService } from './sheets.service';
import { SubjectsService } from './subjects.service';
import { TermsController } from './terms.controller';
import { ExamsController } from './exams.controller';

@Module({
  imports: [StudentsModule, SmsModule],
  controllers: [TermsController, ResultsController, ExamsController],
  providers: [SubjectsService, SheetsService, ResultsService, RecordsService],
  exports: [ResultsService],
})
export class ResultsModule {}
