import { ClassLevel, Sex, StudentStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean, IsEnum, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateIf, ValidateNested,
} from 'class-validator';
import { NewAccountDto } from '../users/dto/user.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || undefined : value);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const RELATIONSHIPS = ['Mother', 'Father', 'Guardian', 'Grandparent', 'Aunt', 'Uncle', 'Sibling', 'Other'];

export class GuardianDto {
  @IsIn(RELATIONSHIPS, { message: `Relationship must be one of: ${RELATIONSHIPS.join(', ')}.` })
  relationship: string;

  /** An existing parent account in the school. */
  @IsOptional()
  @IsUUID()
  parentId?: string;

  /** Or create a new parent account. */
  @IsOptional()
  @ValidateNested()
  @Type(() => NewAccountDto)
  newParent?: NewAccountDto;
}

class StudentDetails {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  surname: string;

  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  firstName: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(60)
  middleName?: string;

  @IsEnum(Sex)
  sex: Sex;

  @Matches(DATE, { message: 'Date of birth must be YYYY-MM-DD.' })
  dateOfBirth: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(40)
  stateOfOrigin?: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(60)
  lgaOfOrigin?: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(250)
  homeAddress?: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(120)
  previousSchool?: string;
}

export class EnrolStudentDto extends StudentDetails {
  /** The class level the student joins at, so they can be allocated to an arm later. Taken from the class if one is given. */
  @IsOptional()
  @IsEnum(ClassLevel)
  entryLevel?: ClassLevel;

  @IsOptional()
  @Matches(DATE, { message: 'Admission date must be YYYY-MM-DD.' })
  admittedOn?: string;

  @IsOptional()
  @IsUUID()
  classArmId?: string;

  /** Set after the school has checked that a possible duplicate is a different child. */
  @IsOptional()
  @IsBoolean()
  confirmDuplicate?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => GuardianDto)
  guardian?: GuardianDto;
}

export class UpdateStudentDto {
  @Transform(trim) @IsOptional() @IsString() @MinLength(2) @MaxLength(60) surname?: string;
  @Transform(trim) @IsOptional() @IsString() @MinLength(2) @MaxLength(60) firstName?: string;
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value)) @IsOptional() @IsString() @MaxLength(60) middleName?: string;
  @IsOptional() @IsEnum(Sex) sex?: Sex;
  @IsOptional() @Matches(DATE, { message: 'Date of birth must be YYYY-MM-DD.' }) dateOfBirth?: string;
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value)) @IsOptional() @IsString() @MaxLength(40) stateOfOrigin?: string;
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value)) @IsOptional() @IsString() @MaxLength(60) lgaOfOrigin?: string;
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value)) @IsOptional() @IsString() @MaxLength(250) homeAddress?: string;
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value)) @IsOptional() @IsString() @MaxLength(120) previousSchool?: string;
}

export class PlaceDto {
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  classArmId: string | null;
}

export class WithdrawDto {
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  reason: string;

  @IsOptional()
  @Matches(DATE, { message: 'Date must be YYYY-MM-DD.' })
  date?: string;
}

export class ListStudentsQuery {
  @IsOptional() @IsUUID() classId?: string;
  @IsOptional() @IsUUID() schoolId?: string;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsEnum(StudentStatus) status?: StudentStatus;
  @IsOptional() @IsIn(['true', 'false']) unplaced?: string;
  /** Adds this term's attendance rate and average score to each row. */
  @IsOptional() @IsIn(['true', 'false']) stats?: string;
}
