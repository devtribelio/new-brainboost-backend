import { IsEmail, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@/common/openapi/decorators';

export class PreRegistrationDto {
  @ApiProperty({ format: 'email' })
  @IsEmail()
  email!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional({ description: 'Affiliate code of inviting member' })
  @IsOptional()
  @IsString()
  affiliateCode?: string;

  @ApiPropertyOptional({ description: 'Network this pre-registration targets' })
  @IsOptional()
  @IsString()
  networkId?: string;
}
