import { Sex, StaffCategory, StaffStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEmail, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || undefined : value);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const QUALIFICATIONS = ['SSCE', 'OND', 'NCE', 'HND', 'B.Ed', 'B.A.(Ed)', 'B.Sc.(Ed)', 'B.A', 'B.Sc', 'PGDE', 'M.Ed', 'M.A', 'M.Sc', 'PhD', 'Other'];

class StaffFields {
  @Transform(trim) @IsOptional() @IsString() @MaxLength(60) middleName?: string;
  @IsOptional() @Matches(DATE, { message: 'Date of birth must be YYYY-MM-DD.' }) dateOfBirth?: string;
  @Transform(trim) @IsOptional() @IsString() @MaxLength(20) phone?: string;
  @Transform(trim) @IsOptional() @IsEmail({}, { message: 'Enter a valid email address.' }) @MaxLength(254) email?: string;
  @Transform(trim) @IsOptional() @IsString() @MaxLength(60) rank?: string;
  @IsOptional() @IsInt() @Min(1) @Max(17) gradeLevel?: number;
  @IsOptional() @IsInt() @Min(1) @Max(15) step?: number;
  @IsOptional() @Matches(DATE, { message: 'First appointment must be YYYY-MM-DD.' }) firstAppointment?: string;
  @Transform(trim) @IsOptional() @IsString() @MaxLength(30) trcnNumber?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) subjects?: string[];
}

export class CreateStaffDto extends StaffFields {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(60) surname: string;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(60) firstName: string;
  @IsEnum(Sex) sex: Sex;
  @IsEnum(StaffCategory) category: StaffCategory;

  /** Ministry administrators choose the school; school administrators add staff to their own school. */
  @IsOptional() @IsUUID() schoolId?: string;
  /** Date they started at this school. Defaults to today. */
  @IsOptional() @Matches(DATE, { message: 'Posting date must be YYYY-MM-DD.' }) postedOn?: string;
}

export class UpdateStaffDto extends StaffFields {
  @Transform(trim) @IsOptional() @IsString() @MinLength(2) @MaxLength(60) surname?: string;
  @Transform(trim) @IsOptional() @IsString() @MinLength(2) @MaxLength(60) firstName?: string;
  @IsOptional() @IsEnum(Sex) sex?: Sex;
  @IsOptional() @IsEnum(StaffCategory) category?: StaffCategory;
  @IsOptional() @IsEnum(StaffStatus) status?: StaffStatus;
}

export class QualificationDto {
  @IsIn(QUALIFICATIONS, { message: `Qualification must be one of: ${QUALIFICATIONS.join(', ')}.` }) kind: string;
  @Transform(trim) @IsOptional() @IsString() @MaxLength(100) course?: string;
  @Transform(trim) @IsOptional() @IsString() @MaxLength(120) institution?: string;
  @IsOptional() @IsInt() @Min(1950) @Max(2100) year?: number;
}

export class TrainingDto {
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(150) title: string;
  @Transform(trim) @IsOptional() @IsString() @MaxLength(120) provider?: string;
  @Matches(DATE, { message: 'Start date must be YYYY-MM-DD.' }) startDate: string;
  @IsOptional() @Matches(DATE, { message: 'End date must be YYYY-MM-DD.' }) endDate?: string;
  @IsOptional() @IsInt() @Min(1) @Max(2000) hours?: number;
}

export class LinkAccountDto {
  @ValidateIf((_, v) => v !== null) @IsUUID() userId: string | null;
}

export class PostDto {
  @IsUUID() schoolId: string;
  @IsOptional() @Matches(DATE, { message: 'Start date must be YYYY-MM-DD.' }) startDate?: string;
  @Transform(trim) @IsOptional() @IsString() @MaxLength(200) reason?: string;
}

export class PostingRequestDto {
  @IsUUID() staffId: string;
  @IsUUID() toSchoolId: string;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(200) reason: string;
  @IsOptional() @Matches(DATE, { message: 'Effective date must be YYYY-MM-DD.' }) effectiveDate?: string;
}

export class DecideDto {
  @Transform(trim) @IsOptional() @IsString() @MaxLength(200) note?: string;
}

export class ListStaffQuery {
  @IsOptional() @IsUUID() schoolId?: string;
  @Transform(trim) @IsOptional() @IsString() @MaxLength(60) q?: string;
  @IsOptional() @IsEnum(StaffCategory) category?: StaffCategory;
  @IsOptional() @IsEnum(StaffStatus) status?: StaffStatus;
}
