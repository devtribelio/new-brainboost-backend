import { IsEmail } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

/** Query of `GET /event/order/:code`. The payer's email stands in for a session. */
export class EventOrderQueryDto {
  @ApiProperty({ example: 'rina@example.com', description: "Payer's email. A mismatch is 404, not 403." })
  @IsEmail()
  email!: string;
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
