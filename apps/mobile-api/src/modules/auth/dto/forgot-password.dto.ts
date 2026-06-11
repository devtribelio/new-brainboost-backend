import { IsEmail, IsString, Length } from 'class-validator';
import { ApiProperty } from '@bb/common/openapi/decorators';

export class RequestForgotPasswordDto {
  @ApiProperty({ format: 'email', example: 'john.doe@example.com' })
  @IsEmail()
  email!: string;
}

export class ForgotPasswordVerificationDto {
  @ApiProperty({ format: 'email', example: 'john.doe@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ description: '6-digit OTP', example: '123456' })
  @IsString()
  @Length(4, 8)
  code!: string;

  @ApiProperty({ format: 'password', example: 'N3wP4ssw0rd!', description: 'min 8 chars' })
  @IsString()
  @Length(8, 100)
  newPassword!: string;
}

export class ValidateOtpDto {
  @ApiProperty({
    example: 'john.doe@example.com',
    description: 'Phone or email the OTP was sent to',
  })
  @IsString()
  target!: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @Length(4, 8)
  code!: string;

  @ApiProperty({
    enum: ['register', 'forgot_password', 'verify_phone', 'verify_email'],
    example: 'forgot_password',
  })
  @IsString()
  purpose!: string;
}
