import { Module } from '@nestjs/common';
import { StudentsModule } from '../students/students.module';
import { ResultsController } from './results.controller';
import { ResultsService } from './results.service';
import { SheetsService } from './sheets.service';
import { SubjectsService } from './subjects.service';
import { TermsController } from './terms.controller';

@Module({
  imports: [StudentsModule],
  controllers: [TermsController, ResultsController],
  providers: [SubjectsService, SheetsService, ResultsService],
  exports: [ResultsService],
})
export class ResultsModule {}
