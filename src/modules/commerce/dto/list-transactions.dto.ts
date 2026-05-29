import { IsDateString, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@bb/common/openapi/decorators';

const TX_STATUSES = ['PENDING', 'PAID', 'EXPIRED', 'FAILED', 'CANCELED', 'REFUNDED'] as const;
export type TxStatus = (typeof TX_STATUSES)[number];

function parseStatusList(raw: unknown): TxStatus[] | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const arr = Array.isArray(raw) ? raw : String(raw).split(',');
  const cleaned = arr
    .map((v) => String(v).trim().toUpperCase())
    .filter((v) => v.length > 0);
  const valid = cleaned.filter((v): v is TxStatus =>
    (TX_STATUSES as readonly string[]).includes(v),
  );
  return valid.length > 0 ? Array.from(new Set(valid)) : undefined;
}

export class ListTransactionsQueryDto {
  @ApiPropertyOptional({ type: 'integer', example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ type: 'integer', example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  perPage?: number;

  @ApiPropertyOptional({
    example: 'PAID,CANCELED',
    description:
      'Comma-separated list of statuses. Valid: PENDING, PAID, EXPIRED, FAILED, CANCELED, REFUNDED.',
  })
  @IsOptional()
  @Transform(({ value }) => parseStatusList(value), { toClassOnly: true })
  status?: TxStatus[];

  @ApiPropertyOptional({
    example: 'react',
    description: 'Case-insensitive substring match against product title.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Inclusive lower bound on createdAt (ISO 8601).',
  })
  @IsOptional()
  @IsDateString()
  createdFrom?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Inclusive upper bound on createdAt (ISO 8601).',
  })
  @IsOptional()
  @IsDateString()
  createdTo?: string;
}
