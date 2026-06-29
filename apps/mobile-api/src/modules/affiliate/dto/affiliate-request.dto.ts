import { IsIn, IsInt, IsNotEmpty, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';
import { AFFILIATE_BASED } from '@bb/domain/affiliate/constants';

const AFFILIATE_BASED_VALUES = Object.values(AFFILIATE_BASED);

/**
 * Body for `POST /affiliate/me/disbursement`. Optional partial payout amount.
 * `amount` is the gross consumed from the withdrawable balance — the member
 * receives `amount - fee`. Omit it to withdraw the full balance (legacy behavior).
 */
export class RequestDisbursementDto {
  @ApiPropertyOptional({
    type: 'integer',
    example: 50_000,
    description:
      'GROSS payout amount (IDR) — this is what is deducted from `withdrawableBalance`, NOT the amount the member receives. The flat fee is taken out of it, so the member receives `amount - fee` (= the `netAmount` returned by GET /affiliate/me/disbursement). Example: amount=50000, fee=5000 → member receives 45000, balance drops by 50000. Constraints: `minBalance <= amount <= withdrawableBalance` and `amount - fee` must exceed the min-net rule. Omit to withdraw the FULL withdrawable balance as gross.',
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  amount?: number;
}

/** Body for `PUT /affiliate/me/bank-account`. The bank used for affiliate payouts. */
export class SetBankAccountDto {
  @ApiProperty({ example: 'BCA', description: 'Xendit bank code (e.g. BCA, MANDIRI, BNI, BRI).' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  bankCode!: string;

  @ApiProperty({ example: '1234567890' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  bankAccountNumber!: string;

  @ApiProperty({ example: 'BUDI SANTOSO', description: 'Account holder name as printed on the bank account.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  bankAccountName!: string;
}

/** Body for `POST /affiliate/me/kyc`. Manual KYC submission (admin reviews). */
export class SubmitKycDto {
  @ApiProperty({ example: '3201010101010001', description: 'National ID (KTP) number.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  idNumber!: string;

  @ApiProperty({ example: 'https://cdn.example.com/private/kyc/idcard.jpg', description: 'Uploaded ID card image URL.' })
  @IsString()
  @IsNotEmpty()
  idCardUrl!: string;

  @ApiPropertyOptional({ example: 'https://cdn.example.com/private/kyc/selfie.jpg', description: 'Optional selfie-with-ID image URL.' })
  @IsOptional()
  @IsString()
  selfieUrl?: string;
}

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

  @ApiPropertyOptional({
    example: 'CRS123',
    description:
      'Product the link points at (B-5 per-product attribution). legacyId | code | slug. Aliases: `product_code`, `product`, query `?product=`.',
  })
  @IsOptional()
  @IsString()
  productCode?: string;

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

  @ApiPropertyOptional({
    example: 'CRS123',
    description: 'Product the link points at (B-5 per-product attribution). legacyId | code | slug. Alias: `product_code`, `product`.',
  })
  @IsOptional()
  @IsString()
  productCode?: string;

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
