import { IsEmail, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

/**
 * Query of `GET /event/order/:code`. Three credentials are accepted and any ONE
 * suffices: a bearer token (the order's own member), `t` (the signed token an event
 * invoice's redirect carries), or `email` (the payer's — what the summary email
 * link uses).
 *
 * Both fields are optional HERE and the "at least one" rule lives in the service,
 * because the bearer is not in the query at all: a DTO-level one-of cannot see it
 * and would reject a perfectly authenticated request.
 */
export class EventOrderQueryDto {
  @ApiPropertyOptional({
    example: 'rina@example.com',
    description: "Payer's email. A mismatch is 404, not 403.",
  })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({
    description:
      'Opaque signed token from the post-payment redirect. Scoped to this one order, ~24h. Treat as a credential: strip it from the URL after reading it.',
  })
  @IsOptional()
  @IsString()
  t?: string;
}

export class EventOrderTicketDto {
  @ApiProperty({ example: 'BBT-K7M2QD' })
  code!: string;

  @ApiProperty({ example: 'Rina Kusuma' })
  attendeeName!: string;

  @ApiProperty({ example: 'rina@example.com' })
  attendeeEmail!: string;

  @ApiProperty({ enum: ['RESERVED', 'ISSUED', 'EXPIRED', 'VOID'], example: 'ISSUED' })
  status!: string;
}

export class EventOrderEventDto {
  @ApiProperty({ example: 'webinar-tidur-berkualitas' })
  slug!: string;

  @ApiProperty({ example: 'Webinar: Tidur Berkualitas' })
  title!: string;

  @ApiProperty({ example: '2026-09-20T02:00:00.000Z' })
  startsAt!: Date;

  @ApiPropertyOptional({ nullable: true, example: 'Zoom' })
  location!: string | null;
}

export class EventOrderResultDto {
  @ApiProperty({ example: 'BB-20260909-0042' })
  transactionCode!: string;

  @ApiProperty({ enum: ['PENDING', 'PAID', 'EXPIRED', 'CANCELED'], example: 'PAID' })
  status!: string;

  @ApiProperty({ example: 240000 })
  amount!: number;

  @ApiPropertyOptional({ nullable: true, example: '2026-09-09T07:12:00.000Z' })
  paidAt!: Date | null;

  @ApiPropertyOptional({ nullable: true, example: '2026-09-09T14:00:00.000Z' })
  expiredAt!: Date | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'https://checkout.xendit.co/web/abc',
    description: 'Only while PENDING; null otherwise',
  })
  invoiceUrl!: string | null;

  @ApiProperty({ type: () => EventOrderEventDto })
  event!: EventOrderEventDto;

  @ApiProperty({ example: 'Online' })
  ticketTypeName!: string;

  @ApiProperty({ type: () => [EventOrderTicketDto] })
  tickets!: EventOrderTicketDto[];
}
