import { Role } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || undefined : value);

export class NewAccountDto {
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  fullName: string;

  @Transform(trim)
  @IsOptional()
  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(254)
  email?: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;
}

export class CreateUserDto extends NewAccountDto {
  @IsEnum(Role)
  role: Role;

  @IsOptional()
  @IsUUID()
  schoolId?: string;
}

export class UpdateUserDto {
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  fullName?: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(254)
  email?: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ListUsersQuery {
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @IsOptional()
  @IsUUID()
  schoolId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}
