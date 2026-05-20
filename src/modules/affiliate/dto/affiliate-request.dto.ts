import { IsIn, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@/common/openapi/decorators';
import { AFFILIATE_BASED } from '../constants';

const AFFILIATE_BASED_VALUES = Object.values(AFFILIATE_BASED);

/** Body for `POST /affiliate/me/mode`. Controller accepts either field. */
export class SetModeDto {
  @ApiPropertyOptional({
    enum: AFFILIATE_BASED_VALUES,
    example: 'PERFORMANCE',
    description: 'Affiliate mode. Either `mode` or legacy alias `affiliateBased` must be sent.',
  })
  @IsOptional()
  @IsString()
  @IsIn(AFFILIATE_BASED_VALUES)
  mode?: string;

  @ApiPropertyOptional({
    enum: AFFILIATE_BASED_VALUES,
    description: 'Legacy alias for `mode`.',
  })
  @IsOptional()
  @IsString()
  @IsIn(AFFILIATE_BASED_VALUES)
  affiliateBased?: string;
}

/** Body for `POST /affiliate/visits`. All fields optional — endpoint never 4xx. */
export class LogVisitDto {
  @ApiPropertyOptional({
    example: 'AB12CD34',
    description: 'Program code (8 chars). Aliases: `program_code`, query `?program=`.',
  })
  @IsOptional()
  @IsString()
  programCode?: string;

  @ApiPropertyOptional({
    example: 'X7K9Q2',
    description: 'Affiliator personal code (6 chars). Aliases: `affCode`, `aff`, query `?affCode=`.',
  })
  @IsOptional()
  @IsString()
  affiliatorCode?: string;

  @ApiPropertyOptional({ example: 'instagram' })
  @IsOptional()
  @IsString()
  utmSource?: string;

  @ApiPropertyOptional({ example: 'cpc' })
  @IsOptional()
  @IsString()
  utmMedium?: string;

  @ApiPropertyOptional({ example: 'launch-2026' })
  @IsOptional()
  @IsString()
  utmCampaign?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  utmContent?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  utmTerm?: string;

  @ApiPropertyOptional({ description: 'Ad click id (gclid / fbclid / ttclid).' })
  @IsOptional()
  @IsString()
  adId?: string;

  @ApiPropertyOptional({ example: 'meta', enum: ['google', 'meta', 'tiktok'] })
  @IsOptional()
  @IsString()
  adNetwork?: string;

  @ApiPropertyOptional({ description: 'Device id. Also read from header `x-device-id`.' })
  @IsOptional()
  @IsString()
  deviceId?: string;

  @ApiPropertyOptional({ example: 'android', description: 'Also read from header `x-platform`.' })
  @IsOptional()
  @IsString()
  platform?: string;

  @ApiPropertyOptional({ description: 'Also read from header `x-app-version`.' })
  @IsOptional()
  @IsString()
  appVersion?: string;

  @ApiPropertyOptional({ description: 'Android Play Store install referrer string.' })
  @IsOptional()
  @IsString()
  installReferrer?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Client-generated id for idempotent retries — duplicate is a no-op.',
  })
  @IsOptional()
  @IsString()
  clientEventId?: string;
}

/** Body for `POST /affiliate/attribution`. Both codes required (deep-link post-login bind). */
export class LogAttributionDto {
  @ApiProperty({
    example: 'AB12CD34',
    description: 'Program code (8 chars). Alias: `program_code`.',
  })
  @IsString()
  programCode!: string;

  @ApiProperty({
    example: 'X7K9Q2',
    description: 'Affiliator personal code (6 chars). Aliases: `affCode`, `aff`.',
  })
  @IsString()
  affiliatorCode!: string;

  @ApiPropertyOptional({ example: 'instagram' })
  @IsOptional()
  @IsString()
  utmSource?: string;

  @ApiPropertyOptional({ example: 'cpc' })
  @IsOptional()
  @IsString()
  utmMedium?: string;

  @ApiPropertyOptional({ example: 'launch-2026' })
  @IsOptional()
  @IsString()
  utmCampaign?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  utmContent?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  utmTerm?: string;

  @ApiPropertyOptional({ description: 'Ad click id (gclid / fbclid / ttclid).' })
  @IsOptional()
  @IsString()
  adId?: string;

  @ApiPropertyOptional({ example: 'meta', enum: ['google', 'meta', 'tiktok'] })
  @IsOptional()
  @IsString()
  adNetwork?: string;

  @ApiPropertyOptional({ description: 'Device id. Also read from header `x-device-id`.' })
  @IsOptional()
  @IsString()
  deviceId?: string;

  @ApiPropertyOptional({ example: 'android', description: 'Also read from header `x-platform`.' })
  @IsOptional()
  @IsString()
  platform?: string;

  @ApiPropertyOptional({ description: 'Also read from header `x-app-version`.' })
  @IsOptional()
  @IsString()
  appVersion?: string;

  @ApiPropertyOptional({ description: 'Android Play Store install referrer string.' })
  @IsOptional()
  @IsString()
  installReferrer?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Client-generated id for idempotent retries — duplicate is a no-op.',
  })
  @IsOptional()
  @IsString()
  clientEventId?: string;
}
