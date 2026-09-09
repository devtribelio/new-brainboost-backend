import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

/**
 * Upper bound only — the real limit is the ticket type's `maxPerOrder`, which
 * the service enforces. This is here so a 10 000-attendee body is rejected
 * before it reaches the database.
 */
const MAX_ATTENDEES = 50;

export class EventAttendeeDto {
  @ApiProperty({ example: 'Rina Kusuma' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ example: 'rina@example.com', description: 'Normalised to lowercase server-side' })
  @IsEmail()
  email!: string;
}

export class EventBuyerDto {
  @ApiProperty({ example: 'Rina Kusuma' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ example: 'rina@example.com' })
  @IsEmail()
  email!: string;

  @ApiPropertyOptional({ example: '081234567890' })
  @IsOptional()
  @IsString()
  phone?: string;
}

/** Tracking-link snapshot. Same shape the product checkout accepts. */
export class EventCheckoutSourceDto {
  @ApiPropertyOptional({ example: '0190a4d1-8d3b-7c2f-9a11-2f5c1e7d9a01', description: 'Cookie `bb_gid`' })
  @IsOptional()
  @IsString()
  guestId?: string;

  @ApiPropertyOptional({ example: 'instagram' })
  @IsOptional()
  @IsString()
  utmSource?: string;

  @ApiPropertyOptional({ example: 'social' })
  @IsOptional()
  @IsString()
  utmMedium?: string;

  @ApiPropertyOptional({ example: 'webinar-sep' })
  @IsOptional()
  @IsString()
  utmCampaign?: string;

  @ApiPropertyOptional({ example: 'story-1' })
  @IsOptional()
  @IsString()
  utmContent?: string;

  @ApiPropertyOptional({ example: 'tidur' })
  @IsOptional()
  @IsString()
  utmTerm?: string;
}

export class EventCheckoutDto {
  @ApiProperty({ example: '0199c3a1-0000-7000-8000-000000000001' })
  @IsUUID()
  ticketTypeId!: string;

  @ApiPropertyOptional({
    type: () => EventBuyerDto,
    description: 'Required when logged out. IGNORED when a valid bearer is sent.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => EventBuyerDto)
  buyer?: EventBuyerDto;

  @ApiProperty({
    type: () => [EventAttendeeDto],
    description:
      'One entry per ticket. Emails may repeat — buying several tickets to your own address is legitimate.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ATTENDEES)
  @ValidateNested({ each: true })
  @Type(() => EventAttendeeDto)
  attendees!: EventAttendeeDto[];

  @ApiPropertyOptional({ example: 'HEMAT20' })
  @IsOptional()
  @IsString()
  voucherCode?: string;

  @ApiPropertyOptional({ type: () => EventCheckoutSourceDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => EventCheckoutSourceDto)
  source?: EventCheckoutSourceDto;
}

export class EventCheckoutTicketDto {
  @ApiProperty({ example: 'BBT-K7M2QD', description: 'Not valid until the order is PAID' })
  code!: string;

  @ApiProperty({ example: 'Rina Kusuma' })
  attendeeName!: string;

  @ApiProperty({ example: 'rina@example.com' })
  attendeeEmail!: string;
}

export class EventCheckoutPaymentDto {
  @ApiProperty({ example: '0199c3b3-0000-7000-8000-000000000001' })
  paymentId!: string;

  @ApiProperty({ enum: ['PENDING', 'SUCCESS'], example: 'PENDING' })
  status!: string;

  @ApiPropertyOptional({
    nullable: true,
    example: 'https://checkout.xendit.co/web/abc',
    description: 'Send the buyer here. `null` for a free ticket — go to the success page instead.',
  })
  invoiceUrl!: string | null;
}

export class EventCheckoutResultDto {
  @ApiProperty({ example: '0199c3b2-0000-7000-8000-000000000001' })
  transactionId!: string;

  @ApiProperty({ example: 'BB-20260909-0042', description: 'Used in the order status URL' })
  transactionCode!: string;

  @ApiProperty({ example: 300000 })
  itemTotal!: number;

  @ApiProperty({ example: 60000 })
  voucherAmount!: number;

  @ApiProperty({ example: 240000, description: 'Amount due' })
  amount!: number;

  @ApiProperty({ example: '2026-09-09T14:00:00.000Z', description: 'Seats are released after this' })
  expiredAt!: Date;

  @ApiProperty({ type: () => EventCheckoutPaymentDto })
  payment!: EventCheckoutPaymentDto;

  @ApiProperty({ type: () => [EventCheckoutTicketDto] })
  tickets!: EventCheckoutTicketDto[];
}
