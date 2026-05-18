import { ApiProperty, ApiPropertyOptional } from '@/common/openapi/decorators';

/**
 * Minimal projection of Xendit VA callback payload — only fields the handler reads.
 * Xendit may include additional fields; passthrough is tolerated.
 */
export class XenditVaCallbackDto {
  @ApiProperty({ example: 'va-xnd-id-123' })
  id!: string;

  @ApiProperty({ example: 'commerce-tx-abc' })
  external_id!: string;

  @ApiProperty({ example: 'COMPLETED', enum: ['COMPLETED', 'EXPIRED', 'FAILED', 'PENDING'] })
  status!: string;

  @ApiPropertyOptional({ example: 'payment-id-xyz' })
  payment_id?: string;

  @ApiPropertyOptional({ example: 'BCA' })
  bank_code?: string;

  @ApiPropertyOptional({ example: '8888812345678901' })
  account_number?: string;

  @ApiPropertyOptional({ example: 500_000 })
  amount?: number;

  @ApiPropertyOptional({ example: 500_000 })
  paid_amount?: number;

  @ApiPropertyOptional({ format: 'date-time' })
  transaction_timestamp?: string;
}

/**
 * Xendit eWallet callback uses a wrapped envelope: { event, data: {...} }.
 */
export class XenditEwalletDataDto {
  @ApiProperty({ example: 'ewc_xnd_id_123' })
  id!: string;

  @ApiPropertyOptional({ example: 'commerce-tx-abc' })
  reference_id?: string;

  @ApiProperty({ example: 'SUCCEEDED', enum: ['SUCCEEDED', 'FAILED', 'VOIDED', 'PENDING'] })
  status!: string;

  @ApiPropertyOptional({ example: 'ID_OVO' })
  channel_code?: string;

  @ApiPropertyOptional({ example: 100_000 })
  charge_amount?: number;

  @ApiPropertyOptional({ example: 100_000 })
  capture_amount?: number;

  @ApiPropertyOptional({ example: 'INSUFFICIENT_BALANCE' })
  failure_code?: string;
}

export class XenditEwalletCallbackDto {
  @ApiProperty({ example: 'ewallet.capture' })
  event!: string;

  @ApiPropertyOptional({ format: 'date-time' })
  created?: string;

  @ApiProperty({ type: () => XenditEwalletDataDto })
  data!: XenditEwalletDataDto;
}

/**
 * Xendit Credit Card callback (capture / charge_result).
 */
export class XenditCcCallbackDto {
  @ApiProperty({ example: 'cc-charge-id-123' })
  id!: string;

  @ApiProperty({ example: 'commerce-tx-abc' })
  external_id!: string;

  @ApiProperty({ example: 'CAPTURED', enum: ['CAPTURED', 'AUTHORIZED', 'FAILED', 'REVERSED'] })
  status!: string;

  @ApiPropertyOptional({ example: 500_000 })
  amount?: number;

  @ApiPropertyOptional({ example: 'VISA' })
  card_brand?: string;

  @ApiPropertyOptional({ example: '400000XXXXXX0002' })
  masked_card_number?: string;

  @ApiPropertyOptional({ example: 'STOLEN_CARD' })
  failure_reason?: string;
}
