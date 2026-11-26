import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsDefined, IsIn, IsObject, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { Request, Response } from 'express';
import { memoryStorage } from 'multer';
import { AuthUser } from '../common/auth-user';
import { CurrentUser, Roles } from '../common/decorators';
import { OVERSIGHT_ROLES } from '../common/roles';
import { INSPECTORS, InspectionsService, MAX_PHOTO_BYTES } from './inspections.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || undefined : value);

class CreateInspectionDto {
  /** Made by the phone when the inspection is recorded, so a retried upload is saved once. */
  @IsString() @MinLength(8) @MaxLength(64) clientId: string;
  @IsUUID() schoolId: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Visit date must be YYYY-MM-DD.' }) visitedOn: string;
  @IsDefined() @IsObject() answers: Record<string, unknown>;
  @Transform(trim) @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

class PhotoDto {
  @IsString() @MinLength(8) @MaxLength(64) clientId: string;
  @IsString() @MaxLength(30) section: string;
  @Transform(trim) @IsOptional() @IsString() @MaxLength(200) caption?: string;
}

class ListQuery {
  @IsOptional() @IsUUID() schoolId?: string;
  @IsOptional() @IsIn(['GOOD', 'FAIR', 'POOR', 'CRITICAL']) overall?: string;
  @IsOptional() @IsIn(['true', 'false']) mine?: string;
  @IsOptional() @IsIn(['URGENT', 'PLANNED', 'RESOLVED', 'NONE']) followUp?: string;
}

class FollowUpDto {
  @IsIn(['URGENT', 'PLANNED', 'RESOLVED']) status: string;
  @Transform(trim) @IsOptional() @IsString() @MaxLength(500) note?: string;
}

@Controller('inspections')
@Roles(...OVERSIGHT_ROLES, Role.SCHOOL_ADMIN)
export class InspectionsController {
  constructor(private readonly inspections: InspectionsService) {}

  @Get('template')
  template() {
    return this.inspections.template();
  }

  @Get()
  list(@CurrentUser() me: AuthUser, @Query() q: ListQuery) {
    return this.inspections.list(me, q);
  }

  @Get('standards')
  @Roles(...OVERSIGHT_ROLES)
  standards(@CurrentUser() me: AuthUser) {
    return this.inspections.standards(me);
  }

  @Patch(':id/follow-up')
  @Roles(Role.MINISTRY_ADMIN, Role.MINISTRY_OFFICER, Role.LGA_OFFICER)
  followUp(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: FollowUpDto, @Req() req: Request) {
    return this.inspections.setFollowUp(me, id, dto, req.ip ?? null);
  }

  @Get('photos/:photoId')
  async photo(@CurrentUser() me: AuthUser, @Param('photoId', ParseUUIDPipe) photoId: string, @Res() res: Response) {
    const p = await this.inspections.photo(me, photoId);
    res.set({ 'Content-Type': p.contentType, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    res.send(p.body);
  }

  @Get(':id')
  get(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.inspections.get(me, id);
  }

  @Post()
  @Roles(...INSPECTORS)
  create(@CurrentUser() me: AuthUser, @Body() dto: CreateInspectionDto, @Req() req: Request) {
    return this.inspections.create(me, dto, req.ip ?? null);
  }

  /** multipart/form-data: `photo` (the image), `clientId`, `section`, `caption`. */
  @Post(':id/photos')
  @Roles(...INSPECTORS)
  @UseInterceptors(FileInterceptor('photo', { storage: memoryStorage(), limits: { fileSize: MAX_PHOTO_BYTES + 1, files: 1, fields: 5 } }))
  addPhoto(
    @CurrentUser() me: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: PhotoDto,
    @Req() req: Request,
  ) {
    return this.inspections.addPhoto(me, id, file, dto, req.ip ?? null);
  }
}
