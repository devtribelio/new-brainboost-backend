import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

/** One purchasable ticket kind of an event. Price comes from the linked product. */
export class EventTicketTypeDto {
  @ApiProperty({ example: '0199c3a1-0000-7000-8000-000000000001' })
  id!: string;

  @ApiProperty({ example: 'Online' })
  name!: string;

  @ApiProperty({ enum: ['ONLINE', 'OFFLINE'], example: 'ONLINE' })
  kind!: string;

  @ApiProperty({ example: 150000, description: 'Integer rupiah. No decimals, no currency prefix.' })
  price!: number;

  @ApiPropertyOptional({
    example: 42,
    nullable: true,
    description: 'Seats left. `null` = unlimited. A snapshot — checkout is the final word.',
  })
  remainingQuota!: number | null;

  @ApiProperty({ example: false })
  isSoldOut!: boolean;

  @ApiProperty({ example: 10 })
  maxPerOrder!: number;

  @ApiPropertyOptional({ nullable: true, example: null, description: '`null` = already open' })
  saleStartsAt!: Date | null;

  @ApiPropertyOptional({
    nullable: true,
    example: '2026-09-19T17:00:00.000Z',
    description: '`null` = until the event starts',
  })
  saleEndsAt!: Date | null;

  @ApiProperty({ example: true, description: 'Sale window open AND seats left' })
  isOnSale!: boolean;
}

/** Swiper card. Deliberately thin — the home page renders many of these. */
export class EventListItemDto {
  @ApiProperty({ example: 'webinar-tidur-berkualitas' })
  slug!: string;

  @ApiProperty({ example: 'Webinar: Tidur Berkualitas' })
  title!: string;

  @ApiPropertyOptional({ nullable: true, example: 'https://cdn.brainboost.id/events/cover.webp' })
  coverUrl!: string | null;

  @ApiProperty({ example: '2026-09-20T02:00:00.000Z', description: 'UTC. Render in Asia/Jakarta.' })
  startsAt!: Date;

  @ApiPropertyOptional({ nullable: true, example: '2026-09-20T04:00:00.000Z' })
  endsAt!: Date | null;

  @ApiPropertyOptional({ nullable: true, example: 'Zoom', description: '`null` for an online event with no venue' })
  location!: string | null;

  @ApiProperty({ example: 150000, description: 'Cheapest ticket type still on sale' })
  lowestPrice!: number;

  @ApiPropertyOptional({
    nullable: true,
    example: 42,
    description: 'Seats left across every type. `null` if any type is unlimited.',
  })
  remainingQuota!: number | null;
}

export class EventListResultDto {
  @ApiProperty({ type: () => [EventListItemDto] })
  items!: EventListItemDto[];
}

export class EventDetailDto {
  @ApiProperty({ example: 'webinar-tidur-berkualitas' })
  slug!: string;

  @ApiProperty({ example: 'Webinar: Tidur Berkualitas' })
  title!: string;

  @ApiPropertyOptional({ nullable: true, example: '<p>Materi…</p>', description: 'HTML from the backoffice editor' })
  description!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'https://cdn.brainboost.id/events/cover.webp' })
  coverUrl!: string | null;

  @ApiProperty({ example: '2026-09-20T02:00:00.000Z' })
  startsAt!: Date;

  @ApiPropertyOptional({ nullable: true, example: '2026-09-20T04:00:00.000Z' })
  endsAt!: Date | null;

  @ApiPropertyOptional({ nullable: true, example: 'Zoom' })
  location!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'https://maps.app.goo.gl/xyz' })
  locationUrl!: string | null;

  @ApiProperty({ enum: ['DRAFT', 'ON_SALE', 'CLOSED', 'CANCELED'], example: 'ON_SALE' })
  status!: string;

  @ApiProperty({
    example: true,
    description:
      'The single gate for the buy button. Folds event status, whether it is over, and ticket availability into one boolean — do not reassemble it client-side.',
  })
  canBuy!: boolean;

  @ApiProperty({ type: () => [EventTicketTypeDto] })
  ticketTypes!: EventTicketTypeDto[];
}
