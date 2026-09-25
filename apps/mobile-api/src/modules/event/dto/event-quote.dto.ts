import { Type } from 'class-transformer';
import { IsInt, IsUUID, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

/** Query of `GET /api/event/quote`. */
export class EventQuoteQueryDto {
  @ApiProperty({ example: '0199c3a1-0000-7000-8000-000000000001' })
  @IsUUID()
  ticketTypeId!: string;

  @ApiProperty({
    example: 4,
    description: 'Tickets wanted. Rejected above the kind\'s `maxPerOrder`.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty!: number;
}

/** One line of the price explanation: a package used, or the leftover singles. */
export class EventQuoteLineDto {
  @ApiProperty({ example: 'Trio', description: 'Tier label, its "Paket N" fallback, or "Satuan".' })
  label!: string;

  @ApiProperty({ example: 3, description: 'Tickets covered by this line.' })
  qty!: number;

  @ApiProperty({ example: 500000 })
  amount!: number;
}

export class EventQuoteResultDto {
  @ApiProperty({ example: 4 })
  qty!: number;

  @ApiProperty({
    example: 700000,
    description:
      'Total for the tickets, after the bundle ladder. Always the CHEAPEST combination for this quantity — a buyer who picks four singles pays the same as one who picks Trio + Solo.',
  })
  itemTotal!: number;

  @ApiProperty({
    type: () => [EventQuoteLineDto],
    description: 'Render the price summary from this; do not recompute it.',
  })
  breakdown!: EventQuoteLineDto[];

  @ApiPropertyOptional({
    example: 0,
    description:
      'Always 0 here: this endpoint is public and applies no voucher. The discount is computed at checkout, where the member is known.',
  })
  voucherAmount!: number;

  @ApiProperty({
    example: 700000,
    description: 'Equal to `itemTotal` — present so the shape matches the checkout response.',
  })
  amount!: number;
}
