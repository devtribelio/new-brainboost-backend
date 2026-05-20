import { ApiProperty, ApiPropertyOptional } from '@/common/openapi/decorators';

export class StartCheckoutResultDto {
  @ApiProperty({ format: 'uuid' })
  transactionId!: string;

  @ApiProperty({ example: 'BB-20260513-0042' })
  transactionCode!: string;

  @ApiProperty({ example: 500_000 })
  itemTotal!: number;

  @ApiProperty({ example: 50_000 })
  voucherAmount!: number;

  @ApiProperty({ example: 450_000 })
  amount!: number;

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

  @ApiProperty({ example: 450_000 })
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

  @ApiProperty({ type: 'integer', example: 450_000, description: 'Grand total' })
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

  @ApiPropertyOptional({ example: 'AMOUNT', enum: ['PERCENT', 'AMOUNT'] })
  type?: string;

  @ApiPropertyOptional({ example: 'Voucher quota exhausted' })
  reason?: string;
}
