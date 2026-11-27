import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

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

export class LoginCodeDto {
  @IsString()
  @MinLength(20)
  @MaxLength(100)
  mfaToken: string;

  /** A 6-digit authenticator code, or a recovery code such as ABCDE-FGHJK. */
  @IsString()
  @MaxLength(20)
  @Matches(/^[A-Za-z0-9\s-]+$/)
  code: string;
}

export class TwoStepCodeDto {
  @IsString()
  @MaxLength(20)
  @Matches(/^[A-Za-z0-9\s-]+$/)
  code: string;
}

export class TwoStepOffDto extends TwoStepCodeDto {
  @IsString()
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
