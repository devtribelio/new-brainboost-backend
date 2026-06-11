import { IsEmail, IsOptional, IsString, Length, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

// email/phone: at least one required (checked in the service — class-validator
// has no clean either-or). Both present → email wins; the same priority is
// applied on verification so issue/consume always target the same channel.

export class RequestForgotPasswordDto {
  @ApiPropertyOptional({ format: 'email', example: 'john.doe@example.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({
    example: '08111111111',
    description: 'Phone number; any of 0811…/62811…/+62811… forms. OTP goes to WhatsApp.',
  })
  @IsOptional()
  @Matches(/^\+?[0-9]{6,20}$/, { message: 'phone must be 6-20 digits, optional leading +' })
  phone?: string;
}

export class ForgotPasswordVerificationDto {
  @ApiPropertyOptional({ format: 'email', example: 'john.doe@example.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: '08111111111', description: 'Same rules as request step' })
  @IsOptional()
  @Matches(/^\+?[0-9]{6,20}$/, { message: 'phone must be 6-20 digits, optional leading +' })
  phone?: string;

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
