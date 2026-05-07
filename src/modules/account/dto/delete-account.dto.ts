import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@/common/openapi/decorators';

export class RequestDeleteAccountDto {
  @ApiPropertyOptional({ description: 'User confirmation flag' })
  @IsOptional()
  @IsBoolean()
  agree?: boolean;
}

export class VerificationDeleteAccountDto {
  @ApiProperty({ description: 'OTP delivered to email' })
  @IsString()
  @Length(4, 8)
  otpCode!: string;
}
