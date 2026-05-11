import { ApiProperty, ApiPropertyOptional } from '@/common/openapi/decorators';

export class CommissionRecentEntryDto {
  @ApiProperty({ format: 'uuid', example: 'commission-uuid-1' })
  id!: string;

  @ApiProperty({ type: 'number', example: 500000 })
  amount!: number;

  @ApiProperty({
    enum: ['PENDING', 'BALANCE', 'PAID', 'CANCELLED'],
    example: 'PENDING',
  })
  status!: string;

  @ApiPropertyOptional({
    nullable: true,
    example: 'product_sale',
    description: 'Origin of the commission entry',
  })
  source?: string | null;

  @ApiProperty({ format: 'date-time', example: '2024-05-10T00:00:00.000Z' })
  createdAt!: string;
}

export class CommissionSummaryDto {
  @ApiProperty({
    type: 'number',
    example: 5000000,
    description: 'Sum of PENDING + BALANCE commissions',
  })
  total!: number;

  @ApiProperty({ type: 'integer', example: 12, description: 'Count of matching commission rows' })
  count!: number;

  @ApiProperty({ enum: ['IDR'], example: 'IDR' })
  currency!: string;

  @ApiProperty({
    type: 'array',
    itemType: () => CommissionRecentEntryDto,
    description: 'Up to 10 most recent commission entries (all statuses)',
  })
  recent!: CommissionRecentEntryDto[];
}
