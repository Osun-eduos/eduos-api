import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsObject, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class AddSubjectDto {
  @IsString() @MaxLength(8) subjectCode!: string;
  @IsOptional() @IsUUID() teacherId?: string;
}

export class SetTeacherDto {
  @IsOptional() @IsUUID() teacherId?: string | null;
}

export class ScoreDto {
  @IsUUID() studentId!: string;
  @IsObject() marks!: Record<string, number | null>;
}

export class SaveScoresDto {
  @IsUUID() classSubjectId!: string;
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => ScoreDto) scores!: ScoreDto[];
}

export class SheetQuery {
  @IsUUID() classSubjectId!: string;
  @IsOptional() @IsUUID() termId?: string;
}

export class ReturnDto {
  @Transform(trim) @IsString() @MinLength(3, { message: 'Say what needs changing.' }) @MaxLength(500) note!: string;
}

export class ClassTermQuery {
  @IsUUID() classId!: string;
  @IsOptional() @IsUUID() termId?: string;
}

export class TermQuery {
  @IsOptional() @IsUUID() termId?: string;
  @IsOptional() @IsUUID() schoolId?: string;
}

export class RemarkDto {
  @IsUUID() studentId!: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) teacherRemark?: string | null;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) principalRemark?: string | null;
}

export class SaveRemarksDto {
  @IsUUID() classId!: string;
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => RemarkDto) remarks!: RemarkDto[];
}

export class ReleaseDto {
  @IsUUID() classId!: string;
}
