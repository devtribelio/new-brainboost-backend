import { IsString, IsUUID } from 'class-validator';
import { ApiProperty } from '@bb/common/openapi/decorators';

/**
 * Create payment for an existing PENDING CommerceTransaction.
 *
 * Backend auto-routes:
 * - `tx.amount === 0` → voucher 100% bypass (no Xendit call)
 * - `tx.amount > 0`   → create Xendit Invoice; mobile WebView opens `invoiceUrl`
 */
export class PayDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  transactionId!: string;
}

export class CancelTransactionDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  transactionId!: string;
}

export class ValidateVoucherDto {
  @ApiProperty({ example: 'EARLYBIRD' })
  @IsString()
  code!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  productId!: string;
}
