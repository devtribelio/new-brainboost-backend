import { IsEmail, IsString, Length } from 'class-validator';
import { ApiProperty } from '@/common/openapi/decorators';

export class RequestForgotPasswordDto {
  @ApiProperty({ format: 'email' })
  @IsEmail()
  email!: string;
}

export class ForgotPasswordVerificationDto {
  @ApiProperty({ format: 'email' })
  @IsEmail()
  email!: string;

  @ApiProperty({ description: '4-8 digit OTP', example: '123456' })
  @IsString()
  @Length(4, 8)
  code!: string;

  @ApiProperty({ format: 'password', description: 'min 8 chars' })
  @IsString()
  @Length(8, 100)
  newPassword!: string;
}

export class ValidateOtpDto {
  @ApiProperty({ description: 'Phone or email the OTP was sent to' })
  @IsString()
  target!: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @Length(4, 8)
  code!: string;

  @ApiProperty({ enum: ['register', 'forgot_password', 'verify_phone', 'verify_email'] })
  @IsString()
  purpose!: string;
}
