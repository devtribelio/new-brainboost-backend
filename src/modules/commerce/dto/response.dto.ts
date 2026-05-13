import { ApiProperty, ApiPropertyOptional } from '@/common/openapi/decorators';

export class FeePreviewBanksDto {
  @ApiProperty({ example: 4000 }) BCA!: number;
  @ApiProperty({ example: 4000 }) BNI!: number;
  @ApiProperty({ example: 4000 }) MANDIRI!: number;
  @ApiProperty({ example: 5500 }) BRI!: number;
  @ApiProperty({ example: 4500 }) PERMATA!: number;
}

export class FeePreviewEwalletDto {
  @ApiProperty({ example: 9900 }) OVO!: number;
  @ApiProperty({ example: 6750 }) DANA!: number;
  @ApiProperty({ example: 6750 }) LINKAJA!: number;
  @ApiProperty({ example: 9000 }) GOPAY!: number;
  @ApiProperty({ example: 9000 }) SHOPEEPAY!: number;
}

export class FeePreviewDto {
  @ApiProperty({ example: 12500 })
  cc!: number;

  @ApiProperty({ type: () => FeePreviewBanksDto })
  va!: FeePreviewBanksDto;

  @ApiProperty({ type: () => FeePreviewEwalletDto })
  eWallet!: FeePreviewEwalletDto;
}

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

  @ApiProperty({ type: () => FeePreviewDto })
  feePreview!: FeePreviewDto;

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

  @ApiPropertyOptional({ nullable: true, example: '8888812345678901' })
  vaNumber?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'BCA' })
  bank?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'OVO' })
  ewalletType?: string | null;

  @ApiPropertyOptional({ nullable: true })
  redirectUrl?: string | null;

  @ApiPropertyOptional({ nullable: true })
  deeplinkUrl?: string | null;

  @ApiPropertyOptional({ nullable: true })
  qrString?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  expiredAt?: string | null;

  @ApiProperty({ example: 462000 })
  amount!: number;

  @ApiProperty({ example: 4000 })
  fee!: number;
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
