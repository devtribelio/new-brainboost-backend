import { IsEmail, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@/common/openapi/decorators';

export class PreRegistrationDto {
  @ApiProperty({ format: 'email', example: 'jane.doe@example.com' })
  @IsEmail()
  email!: string;

  @ApiPropertyOptional({ example: '+628111111111' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional({ example: 'JD000001', description: 'Affiliate code of inviting member' })
  @IsOptional()
  @IsString()
  affiliateCode?: string;

  @ApiPropertyOptional({
    example: '7a3c1a52-9f1b-4f8b-9d2a-1e0a7b1c4d51',
    description: 'Network this pre-registration targets',
  })
  @IsOptional()
  @IsString()
  networkId?: string;
}
