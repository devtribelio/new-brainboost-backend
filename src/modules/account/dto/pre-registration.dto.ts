import { IsEmail, IsNotEmpty, IsOptional, IsString, Length, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@/common/openapi/decorators';

export class PreRegistrationDto {
  @ApiProperty({ example: 'Jane Doe', description: '4-100 chars' })
  @IsString()
  @Length(4, 100)
  name!: string;

  @ApiProperty({ example: '8111111111', description: 'Phone number without country code' })
  @IsString()
  @IsNotEmpty()
  phone!: string;

  @ApiProperty({ format: 'email', example: 'jane.doe@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: '+62', description: 'Country dial code' })
  @IsString()
  @IsNotEmpty()
  phoneCode!: string;

  @ApiProperty({ format: 'password', example: 'secret123', description: 'min 6 chars' })
  @IsString()
  @MinLength(6)
  password!: string;

  @ApiProperty({
    format: 'password',
    example: 'secret123',
    description: 'must equal password (wire-level alias name: confirmation)',
  })
  @IsString()
  @MinLength(6)
  confirmation!: string;

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
