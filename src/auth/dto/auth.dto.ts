import { IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  /** Email address or Nigerian phone number. */
  @IsString()
  @MinLength(3)
  @MaxLength(254)
  identifier: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password: string;
}

export class ChangePasswordDto {
  @IsString()
  @MaxLength(128)
  currentPassword: string;

  @IsString()
  @MaxLength(128)
  newPassword: string;
}
