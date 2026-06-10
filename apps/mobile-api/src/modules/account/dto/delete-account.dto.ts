import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

export class RequestDeleteAccountDto {
  @ApiPropertyOptional({ type: 'boolean', example: true, description: 'User confirmation flag' })
  @IsOptional()
  @IsBoolean()
  agree?: boolean;
}

export class VerificationDeleteAccountDto {
  @ApiProperty({ example: '1234', description: '4-digit OTP delivered to email' })
  @IsString()
  @Length(4, 8)
  otpCode!: string;
}
