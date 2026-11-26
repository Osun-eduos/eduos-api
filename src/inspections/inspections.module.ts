import { Module } from '@nestjs/common';
import { StorageService } from '../storage/storage.service';
import { InspectionsController } from './inspections.controller';
import { InspectionsService } from './inspections.service';

@Module({ controllers: [InspectionsController], providers: [InspectionsService, StorageService] })
export class InspectionsModule {}
