import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

export class RequestDeleteAccountDto {
  @ApiPropertyOptional({ type: 'boolean', example: true, description: 'User confirmation flag' })
  @IsOptional()
  @IsBoolean()
  agree?: boolean;
}

export class VerificationDeleteAccountDto {
  @ApiProperty({ example: '123456', description: '6-digit OTP delivered to email or WhatsApp' })
  @IsString()
  @Length(4, 8)
  otpCode!: string;
}
