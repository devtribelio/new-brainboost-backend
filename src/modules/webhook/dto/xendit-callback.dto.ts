import { IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@/common/openapi/decorators';

/**
 * Xendit Invoice webhook payload (flat envelope, no `data:` wrapper).
 *
 * Triggered on Invoice state transitions: PAID / EXPIRED. Configure dashboard
 * callback URLs:
 *  - Invoices Paid:    POST https://<host>/api/webhook/xendit/invoice
 *  - Invoices Expired: POST https://<host>/api/webhook/xendit/invoice
 *
 * `external_id` is the `referenceId` we sent on createInvoice (used as fallback
 * lookup key when `id` is missing). `status` ∈ PENDING | PAID | SETTLED | EXPIRED.
 *
 * `validateDto(XenditInvoiceCallbackDto)` runs on this route — the decorators
 * below are enforced, not just documentation. `amount` / `paid_amount` are the
 * second factor the handler cross-checks against the stored payment amount.
 */
export class XenditInvoiceCallbackDto {
  @ApiProperty({ example: 'inv-1234abcd-5678-90ef-ghij-klmnopqrstuv' })
  @IsOptional()
  @IsString()
  id?: string;

  @ApiProperty({ example: 'commerce-tx-abc' })
  @IsOptional()
  @IsString()
  external_id?: string;

  @ApiProperty({
    example: 'PAID',
    enum: ['PENDING', 'PAID', 'SETTLED', 'EXPIRED'],
  })
  @IsString()
  @IsNotEmpty()
  status!: string;

  @ApiPropertyOptional({ example: 462_000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  amount?: number;

  @ApiPropertyOptional({ example: 462_000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  paid_amount?: number;

  @ApiPropertyOptional({ example: 'IDR' })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiPropertyOptional({ example: 'BANK_TRANSFER' })
  @IsOptional()
  @IsString()
  payment_method?: string;

  @ApiPropertyOptional({ example: 'BCA' })
  @IsOptional()
  @IsString()
  payment_channel?: string;

  @ApiPropertyOptional({ example: '8888812345678901' })
  @IsOptional()
  @IsString()
  payment_destination?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsString()
  paid_at?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsString()
  expiry_date?: string;
}
