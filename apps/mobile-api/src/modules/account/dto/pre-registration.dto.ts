import { IsEmail, IsNotEmpty, IsOptional, IsString, Length, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';
import { NormalizeEmail } from '@bb/common/utils/transform.util';

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
  @NormalizeEmail()
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

  // Attribution context — full AppsFlyer deferred deeplink payload.
  // All fields optional; backward-compat for callers that don't send them.

  @ApiPropertyOptional({ example: 'PROG2025', description: 'Affiliate program code from share link' })
  @IsOptional()
  @IsString()
  programCode?: string;

  @ApiPropertyOptional({ example: 'facebook', description: 'UTM source' })
  @IsOptional()
  @IsString()
  utmSource?: string;

  @ApiPropertyOptional({ example: 'social', description: 'UTM medium' })
  @IsOptional()
  @IsString()
  utmMedium?: string;

  @ApiPropertyOptional({ example: 'tahun-baru-2026', description: 'UTM campaign' })
  @IsOptional()
  @IsString()
  utmCampaign?: string;

  @ApiPropertyOptional({ example: 'story-ad-1', description: 'UTM content' })
  @IsOptional()
  @IsString()
  utmContent?: string;

  @ApiPropertyOptional({ example: 'kelas-online', description: 'UTM term' })
  @IsOptional()
  @IsString()
  utmTerm?: string;

  @ApiPropertyOptional({ example: '1234567890', description: 'Ad ID (gclid / fbclid / ttclid)' })
  @IsOptional()
  @IsString()
  adId?: string;

  @ApiPropertyOptional({ example: 'meta', description: 'Ad network identifier' })
  @IsOptional()
  @IsString()
  adNetwork?: string;

  @ApiPropertyOptional({
    example: 'utm_source=facebook&utm_medium=social',
    description: 'Raw install referrer string from AppsFlyer / Play Store',
  })
  @IsOptional()
  @IsString()
  installReferrer?: string;

  @ApiPropertyOptional({ example: 'abc123-device-uuid', description: 'Device identifier' })
  @IsOptional()
  @IsString()
  deviceId?: string;

  @ApiPropertyOptional({ example: 'ios', description: 'Platform: ios | android | web' })
  @IsOptional()
  @IsString()
  platform?: string;

  @ApiPropertyOptional({ example: '1.2.3', description: 'App version string' })
  @IsOptional()
  @IsString()
  appVersion?: string;
}
