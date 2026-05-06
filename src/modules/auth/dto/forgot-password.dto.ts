import { IsEmail, IsString, Length } from 'class-validator';

export class RequestForgotPasswordDto {
  @IsEmail()
  email!: string;
}

export class ForgotPasswordVerificationDto {
  @IsEmail()
  email!: string;

  @IsString()
  @Length(4, 8)
  code!: string;

  @IsString()
  @Length(8, 100)
  newPassword!: string;
}

export class ValidateOtpDto {
  @IsString()
  target!: string;

  @IsString()
  @Length(4, 8)
  code!: string;

  @IsString()
  purpose!: string;
}
