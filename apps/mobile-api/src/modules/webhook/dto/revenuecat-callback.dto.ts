import { Type } from 'class-transformer';
import {
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
 * `product_id` is the store SKU resolved against `Product.iapProductId`.
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

  @ApiPropertyOptional({ example: '0192f3a0-member-uuid' })
  @IsOptional()
  @IsString()
  app_user_id?: string;

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

  @ApiPropertyOptional({ example: 9.99, description: 'USD, after store commission' })
  @IsOptional()
  @IsNumber()
  price?: number;

  @ApiPropertyOptional({ example: 149000, description: 'Local currency (IDR for ID users)' })
  @IsOptional()
  @IsNumber()
  price_in_purchased_currency?: number;

  @ApiPropertyOptional({ example: 'IDR' })
  @IsOptional()
  @IsString()
  currency?: string;

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
    description: 'Tax as decimal fraction (e.g. 0.0991). Informational — in tax-inclusive regions like ID, this is consumer-paid PPN, NOT a deduction from developer share.',
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
