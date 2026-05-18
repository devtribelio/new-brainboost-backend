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
 */
export class XenditInvoiceCallbackDto {
  @ApiProperty({ example: 'inv-1234abcd-5678-90ef-ghij-klmnopqrstuv' })
  id!: string;

  @ApiProperty({ example: 'commerce-tx-abc' })
  external_id!: string;

  @ApiProperty({
    example: 'PAID',
    enum: ['PENDING', 'PAID', 'SETTLED', 'EXPIRED'],
  })
  status!: string;

  @ApiPropertyOptional({ example: 462_000 })
  amount?: number;

  @ApiPropertyOptional({ example: 462_000 })
  paid_amount?: number;

  @ApiPropertyOptional({ example: 'IDR' })
  currency?: string;

  @ApiPropertyOptional({ example: 'BANK_TRANSFER' })
  payment_method?: string;

  @ApiPropertyOptional({ example: 'BCA' })
  payment_channel?: string;

  @ApiPropertyOptional({ example: '8888812345678901' })
  payment_destination?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  paid_at?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  expiry_date?: string;
}
