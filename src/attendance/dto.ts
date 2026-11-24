import { AttendanceStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEnum, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateNested } from 'class-validator';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MSG = { message: 'Dates must be written as YYYY-MM-DD.' };
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || undefined : value);

export class MarkDto {
  @IsUUID() studentId!: string;
  @IsEnum(AttendanceStatus) status!: AttendanceStatus;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) note?: string;
}

export class SaveRegisterDto {
  @IsUUID() classId!: string;
  @Matches(DATE, DATE_MSG) date!: string;
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => MarkDto) marks!: MarkDto[];
}

export class RegisterQuery {
  @IsUUID() classId!: string;
  @Matches(DATE, DATE_MSG) date!: string;
}

export class DayQuery {
  @IsOptional() @Matches(DATE, DATE_MSG) date?: string;
  @IsOptional() @IsUUID() schoolId?: string;
}

export class RangeQuery {
  @IsOptional() @Matches(DATE, DATE_MSG) from?: string;
  @IsOptional() @Matches(DATE, DATE_MSG) to?: string;
}

export class ClassRangeQuery extends RangeQuery {
  @IsUUID() classId!: string;
}
