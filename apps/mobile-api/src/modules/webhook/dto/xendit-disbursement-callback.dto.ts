import { IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

/**
 * Xendit Disbursement webhook payload (legacy /disbursements API, flat envelope).
 *
 * Configure dashboard callback URL:
 *   Disbursements: POST https://<host>/api/webhook/xendit/disbursement
 *
 * `external_id` is the idempotency key we sent on createDisbursement (callback
 * match key). `status` ∈ PENDING | COMPLETED | FAILED. Validated by
 * `validateDto(XenditDisbursementCallbackDto)`.
 */
export class XenditDisbursementCallbackDto {
  @ApiPropertyOptional({ example: '57c9010f5ef9e7077bcb96b6' })
  @IsOptional()
  @IsString()
  id?: string;

  @ApiProperty({ example: 'disb-1234abcd-5678-90ef-ghij-klmnopqrstuv' })
  @IsString()
  @IsNotEmpty()
  external_id!: string;

  @ApiProperty({ example: 'COMPLETED', enum: ['PENDING', 'COMPLETED', 'FAILED'] })
  @IsString()
  @IsNotEmpty()
  status!: string;

  @ApiPropertyOptional({ example: 45_000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  amount?: number;

  @ApiPropertyOptional({ example: 'BCA' })
  @IsOptional()
  @IsString()
  bank_code?: string;

  @ApiPropertyOptional({ example: 'INSUFFICIENT_BALANCE', description: 'Set when status is FAILED.' })
  @IsOptional()
  @IsString()
  failure_code?: string;
}
