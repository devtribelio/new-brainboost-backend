import { Type } from 'class-transformer';
import {
  IsArray,
  IsDefined,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

/**
 * RevenueCat webhook `event` object. Only the fields the handler consumes are
 * declared; RC sends many more (ignored). `type` + `id` are required — every
 * other field is optional so an unexpected/partial event still reaches the
 * handler (which decides skip vs ingest), rather than 400-ing at validation.
 *
 * `app_user_id` carries the new `Member.id` (UUID) set by the iOS SDK.
 * `product_id` is the store SKU resolved against `Product.iosProductId`.
 * `transaction_id` is the idempotency / refund-linkage key.
 */
export class RevenueCatEventDto {
  @ApiProperty({ example: 'INITIAL_PURCHASE' })
  @IsString()
  @IsNotEmpty()
  type!: string;

  @ApiProperty({ example: '9f8b...event-uuid' })
  @IsString()
  @IsNotEmpty()
  id!: string;

  @ApiPropertyOptional({
    example: '0192f3a0-member-uuid',
    description:
      'Member UUID set by Purchases.logIn(). NOT guaranteed to be a UUID — a purchase made before login carries `$RCAnonymousID:…` instead.',
  })
  @IsOptional()
  @IsString()
  app_user_id?: string;

  @ApiPropertyOptional({
    example: '$RCAnonymousID:1384062dfb284e6883fafe704b2bb252',
    description: 'The id the customer was first seen under. Usually the anonymous id.',
  })
  @IsOptional()
  @IsString()
  original_app_user_id?: string;

  @ApiPropertyOptional({
    type: 'array',
    itemType: 'string',
    example: ['$RCAnonymousID:1384062dfb284e6883fafe704b2bb252', '0192f3a0-member-uuid'],
    description:
      'Every id aliased to this RC customer. Scanned for a member UUID when app_user_id is anonymous.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  aliases?: string[];

  @ApiPropertyOptional({ example: 'com.brainboost.ios.bbmm_lifetime' })
  @IsOptional()
  @IsString()
  product_id?: string;

  @ApiPropertyOptional({ example: '2000000123456789' })
  @IsOptional()
  @IsString()
  transaction_id?: string;

  @ApiPropertyOptional({ example: '2000000123456789' })
  @IsOptional()
  @IsString()
  original_transaction_id?: string;

  @ApiPropertyOptional({
    example: 22.38,
    description:
      'GROSS price in USD (tax-inclusive, before store commission), converted by RevenueCat from the purchase currency. Verified: a USD-storefront event has price == price_in_purchased_currency exactly. This is the bridge used to normalise foreign purchases to IDR.',
  })
  @IsOptional()
  @IsNumber()
  price?: number;

  @ApiPropertyOptional({
    example: 399000,
    description:
      "Price in the BUYER'S storefront currency — IDR only when they bought from the Indonesian store. Never treat as rupiah without checking `currency`.",
  })
  @IsOptional()
  @IsNumber()
  price_in_purchased_currency?: number;

  @ApiPropertyOptional({
    example: 'IDR',
    description: "ISO code of the buyer's storefront currency. Seen so far: IDR, HKD, MYR, SGD, USD, AUD.",
  })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiPropertyOptional({
    example: 'PRODUCTION',
    description:
      'PRODUCTION | SANDBOX. Declared for audit only — sandbox events ARE ingested (App Review purchases arrive as SANDBOX against the production app). Persisted in commerce_payments.log_request so test rows stay identifiable.',
  })
  @IsOptional()
  @IsString()
  environment?: string;

  @ApiPropertyOptional({ example: 'APP_STORE', description: 'APP_STORE | PLAY_STORE | STRIPE | …' })
  @IsOptional()
  @IsString()
  store?: string;

  @ApiPropertyOptional({
    example: 1786542454487,
    description: 'When the event happened at RevenueCat (ms). Used to pick the FX rate of the purchase day rather than of processing time.',
  })
  @IsOptional()
  @IsNumber()
  event_timestamp_ms?: number;

  @ApiPropertyOptional({
    example: 0.7,
    description: 'RC-computed net% that lands in developer pocket (decimal 0-1). Authoritative — already accounts for commission, tax, and regional handling. Prefer this over deriving from commission/tax.',
  })
  @IsOptional()
  @IsNumber()
  takehome_percentage?: number;

  @ApiPropertyOptional({
    example: 0.2703,
    description: 'Store commission as decimal fraction (e.g. 0.2703). Informational — use takehome_percentage for net.',
  })
  @IsOptional()
  @IsNumber()
  commission_percentage?: number;

  @ApiPropertyOptional({
    example: 0.0991,
    description:
      'Tax as decimal fraction of the GROSS price (e.g. 0.0991 = ID PPN 11%). Currently informational. OPEN QUESTION: `takehome_percentage` is measured against the EX-TAX price while `price` is tax-inclusive, so multiplying them overstates net by 1/(1-tax) — see docs/revenuecat-webhook-port.md before relying on either for settlement math.',
  })
  @IsOptional()
  @IsNumber()
  tax_percentage?: number;

  @ApiPropertyOptional({ description: 'RC subscriber attributes ($email, $displayName, …)' })
  @IsOptional()
  @IsObject()
  subscriber_attributes?: Record<string, { value?: string; updated_at_ms?: number }>;
}

/** RevenueCat webhook envelope: `{ event, api_version }`. */
export class RevenueCatCallbackDto {
  @ApiProperty({ type: () => RevenueCatEventDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => RevenueCatEventDto)
  event!: RevenueCatEventDto;

  @ApiPropertyOptional({ example: '1.0' })
  @IsOptional()
  @IsString()
  api_version?: string;
}
