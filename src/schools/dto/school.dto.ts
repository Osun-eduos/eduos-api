import { Ownership, SchoolLevel } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import { LGA_NAMES } from '../../common/lgas';
import { NewAccountDto } from '../../users/dto/user.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || undefined : value);


/** Facilities a school can report having. */
export const FACILITIES = ['WATER', 'TOILETS', 'POWER', 'ICT', 'LIBRARY', 'LAB', 'FENCE', 'SPORTS', 'FIRST_AID'] as const;

/** Profile details schools and the Ministry can fill in. */
export class SchoolProfileDto {
  @Transform(trim) @IsOptional() @IsString() @MaxLength(80)
  town?: string;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1850) @Max(2100)
  yearEstablished?: number | null;

  /** Osun State lies roughly between 7°N and 8.1°N, 4°E and 5.1°E. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber() @Min(6.9, { message: 'That location is outside Osun State.' }) @Max(8.2, { message: 'That location is outside Osun State.' })
  latitude?: number | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber() @Min(3.9, { message: 'That location is outside Osun State.' }) @Max(5.2, { message: 'That location is outside Osun State.' })
  longitude?: number | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) @Max(500)
  classrooms?: number | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) @Max(20000)
  expectedEnrolment?: number | null;

  @IsOptional() @IsArray() @ArrayMaxSize(FACILITIES.length) @IsIn(FACILITIES, { each: true })
  facilities?: string[];
}

export class CreateSchoolDto extends SchoolProfileDto {
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(160)
  name: string;

  @IsIn(LGA_NAMES, { message: 'Choose one of the 30 Osun State LGAs.' })
  lga: string;

  @IsEnum(SchoolLevel)
  level: SchoolLevel;

  @IsEnum(Ownership)
  ownership: Ownership;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(250)
  address?: string;

  /** Optional: create the school administrator's account at the same time. */
  @IsOptional()
  @ValidateNested()
  @Type(() => NewAccountDto)
  admin?: NewAccountDto;
}

export class UpdateSchoolDto extends SchoolProfileDto {
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(160)
  name?: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(250)
  address?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
