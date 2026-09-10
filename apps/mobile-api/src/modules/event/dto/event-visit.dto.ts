import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

/**
 * Documented for Swagger only — the route mounts NO validateDto. A marketing
 * link that answers 4xx loses the click it exists to measure, so unusable input
 * comes back 200 with `status: "invalid"`.
 */
export class LogEventVisitDto {
  @ApiProperty({ example: '0190a4d1-8d3b-7c2f-9a11-2f5c1e7d9a01', description: 'Cookie `bb_gid`' })
  guestId!: string;

  @ApiPropertyOptional({ example: 'mt-mountain', description: 'Unknown slugs are still logged' })
  eventSlug?: string;

  @ApiPropertyOptional({ example: 'instagram' })
  utmSource?: string;

  @ApiPropertyOptional({ example: 'social' })
  utmMedium?: string;

  @ApiPropertyOptional({ example: 'mt-mountain-instagram-denny' })
  utmCampaign?: string;

  @ApiPropertyOptional({ example: 'story-1' })
  utmContent?: string;

  @ApiPropertyOptional({ example: 'tidur' })
  utmTerm?: string;

  @ApiPropertyOptional({ example: 'https://t.co/abc' })
  referer?: string;

  @ApiPropertyOptional({
    example: '0190a4d2-1111-7c2f-9a11-2f5c1e7d9a02',
    description: 'Dedupes a RETRY, never a visit — a refresh must send a new id',
  })
  clientEventId?: string;
}

export class EventVisitResultDto {
  @ApiProperty({
    enum: ['logged', 'duplicate', 'invalid', 'error'],
    example: 'logged',
    description: 'Always 200; the outcome is reported here, never as a status code',
  })
  status!: string;
}
