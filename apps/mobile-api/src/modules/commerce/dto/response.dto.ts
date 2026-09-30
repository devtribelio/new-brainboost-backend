import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

/**
 * The price summary, identical between quote and submit. Render the card from
 * these five numbers; never recompute one from the others.
 */
export class CheckoutQuoteResultDto {
  @ApiProperty({ example: 500_000, description: 'Catalog price, pre-tax.' })
  itemTotal!: number;

  @ApiProperty({ example: 50_000, description: 'Discount on `itemTotal`.' })
  voucherAmount!: number;

  @ApiProperty({
    example: 11,
    description:
      'PPN rate in percent (11 = 11%), for the label only. 0 while tax is off — hide the tax row when `taxAmount` is 0.',
  })
  taxRate!: number;

  @ApiProperty({
    example: 49_500,
    description: 'round((itemTotal − voucherAmount) × taxRate / 100), half-up, whole rupiah.',
  })
  taxAmount!: number;

  @ApiProperty({
    example: 499_500,
    description: 'Amount due, TAX-INCLUSIVE: itemTotal − voucherAmount + taxAmount. What the invoice is for.',
  })
  amount!: number;
}

export class StartCheckoutResultDto extends CheckoutQuoteResultDto {
  @ApiProperty({ format: 'uuid' })
  transactionId!: string;

  @ApiProperty({ example: 'BB-20260513-0042' })
  transactionCode!: string;

  @ApiProperty({ format: 'date-time' })
  expiredAt!: string;
}

export class CreatePaymentResultDto {
  @ApiProperty({ format: 'uuid' })
  paymentId!: string;

  @ApiProperty({ example: 'PENDING', enum: ['PENDING', 'SUCCESS', 'EXPIRED', 'FAILED', 'CANCELED'] })
  paymentStatus!: string;

  @ApiProperty({
    example: 'PENDING',
    enum: ['PENDING', 'PAID', 'EXPIRED', 'FAILED', 'CANCELED', 'REFUNDED'],
  })
  transactionStatus!: string;

  @ApiPropertyOptional({
    nullable: true,
    example: 'https://checkout-staging.xendit.co/web/0193abc',
    description: 'Xendit-hosted checkout page. Open in mobile WebView.',
  })
  invoiceUrl?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  expiredAt?: string | null;

  @ApiProperty({ example: 450_000 })
  amount!: number;

  @ApiProperty({ example: 0 })
  fee!: number;
}

export class ActivePaymentDto {
  @ApiProperty({ format: 'uuid' })
  paymentId!: string;

  @ApiProperty({ example: 'invoice', enum: ['invoice', 'voucher'] })
  paymentType!: string;

  @ApiProperty({ example: 'PENDING', enum: ['PENDING', 'SUCCESS', 'EXPIRED', 'FAILED', 'CANCELED'] })
  status!: string;

  @ApiPropertyOptional({
    nullable: true,
    example: 'https://checkout-staging.xendit.co/web/0193abc',
    description: 'Xendit-hosted checkout page. Open in mobile WebView.',
  })
  invoiceUrl?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  expiredAt?: string | null;
}

export class TransactionProductSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'React Fundamentals' })
  title!: string;

  @ApiPropertyOptional({ nullable: true })
  thumbnail?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'event_ticket',
    description:
      'What was bought. `event_ticket` means this order is event seats, not a course — its tickets live under the event, and the client should route it there rather than to course content. Free-form on purpose: new kinds appear without a migration, so treat anything unknown as a plain product.',
  })
  type?: string | null;
}

export class TransactionStatusResultDto {
  @ApiProperty({ format: 'uuid' })
  transactionId!: string;

  @ApiProperty({ example: 'BB-20260513-0042' })
  transactionCode!: string;

  @ApiProperty({
    example: 'PENDING',
    enum: ['PENDING', 'PAID', 'EXPIRED', 'FAILED', 'CANCELED', 'REFUNDED'],
  })
  status!: string;

  @ApiProperty({ example: 500_000, description: 'Pre-tax price, as frozen on the order.' })
  itemTotal!: number;

  @ApiProperty({ example: 50_000 })
  voucherAmount!: number;

  @ApiProperty({ example: 11, description: 'Percent frozen at creation; 0 for orders that predate tax.' })
  taxRate!: number;

  @ApiProperty({ example: 49_500, description: '0 for orders that predate tax.' })
  taxAmount!: number;

  @ApiProperty({ example: 499_500, description: 'Tax-inclusive total.' })
  amount!: number;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  expiredAt?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  paidAt?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  canceledAt?: string | null;

  @ApiPropertyOptional({ nullable: true, type: () => ActivePaymentDto })
  activePayment?: ActivePaymentDto | null;

  @ApiProperty({ type: () => TransactionProductSummaryDto })
  product!: TransactionProductSummaryDto;
}

export class CommerceTransactionListItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiPropertyOptional({ nullable: true, type: 'integer', example: 1042 })
  legacyId?: number | null;

  @ApiProperty({ example: 'BB-20260513-0042' })
  code!: string;

  @ApiProperty({ format: 'uuid' })
  memberId!: string;

  @ApiProperty({ format: 'uuid' })
  productId!: string;

  @ApiProperty({ type: 'integer', example: 1 })
  qty!: number;

  @ApiProperty({ type: 'integer', example: 500_000 })
  itemTotal!: number;

  @ApiProperty({ type: 'integer', example: 0 })
  shippingTotal!: number;

  @ApiProperty({ type: 'integer', example: 0 })
  feeTotal!: number;

  @ApiProperty({ type: 'integer', example: 50_000 })
  voucherAmount!: number;

  @ApiProperty({
    example: 11,
    description: 'PPN percent frozen at creation. 0 for orders placed before tax existed.',
  })
  taxRate!: number;

  @ApiProperty({
    type: 'integer',
    example: 49_500,
    description: 'Tax on itemTotal − voucherAmount. 0 for pre-tax orders. NOT part of feeTotal.',
  })
  taxAmount!: number;

  @ApiProperty({ type: 'integer', example: 499_500, description: 'Grand total, tax-inclusive' })
  amount!: number;

  @ApiPropertyOptional({ nullable: true, example: 'PROMO50' })
  voucherCode?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'uuid' })
  voucherId?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'uuid' })
  affiliatorId?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'uuid' })
  programId?: string | null;

  @ApiProperty({
    example: 'PENDING',
    enum: ['PENDING', 'PAID', 'EXPIRED', 'FAILED', 'CANCELED', 'REFUNDED'],
  })
  status!: string;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  paidAt?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  canceledAt?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  expiredAt?: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;

  @ApiProperty({ type: () => TransactionProductSummaryDto })
  product!: TransactionProductSummaryDto;
}

export class VoucherValidateResultDto {
  @ApiProperty({ example: true })
  valid!: boolean;

  @ApiPropertyOptional({ format: 'uuid' })
  voucherId?: string;

  @ApiPropertyOptional({ example: 50_000 })
  voucherAmount?: number;

  @ApiPropertyOptional({ example: 'AMOUNT', enum: ['PERCENT', 'AMOUNT', 'TRIAL'] })
  type?: string;

  /** TRIAL only: days of course access this voucher grants. */
  @ApiPropertyOptional({ example: 7 })
  trialDays?: number | null;

  /** Member-facing copy in Indonesian, returned verbatim — render it, don't map it. */
  @ApiPropertyOptional({ example: 'Kuota voucher sudah habis' })
  reason?: string;
}
