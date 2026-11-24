import { Ownership, SchoolLevel } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { LGA_NAMES } from '../../common/lgas';
import { NewAccountDto } from '../../users/dto/user.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || undefined : value);

export class CreateSchoolDto {
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

export class UpdateSchoolDto {
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
