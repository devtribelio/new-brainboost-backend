import { ApiProperty, ApiPropertyOptional } from '@/common/openapi/decorators';

/**
 * Wire shape for `serializeTopic()`.
 */
export class TopicDto {
  @ApiProperty({ example: 1, description: 'Legacy id when present, falls back to backend uuid' })
  topicId!: number | string;

  @ApiProperty({ example: 'Technology' })
  name!: string;

  @ApiPropertyOptional({
    nullable: true,
    example: 'https://cdn.brainboost.com/topics/technology.png',
    description: 'Legacy alias of iconUrl',
  })
  icon?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    enum: ['emoji', 'image'],
    example: 'emoji',
    description: '`emoji` or `image`; null when no icon',
  })
  iconType?: string | null;

  @ApiPropertyOptional({ nullable: true, enum: ['PUBLIC', 'PRIVATE'], example: 'PUBLIC' })
  type?: string | null;

  @ApiProperty({ type: 'integer', example: 156 })
  countPost!: number;

  @ApiProperty({ type: 'integer', example: 1 })
  orderNumber!: number;

  @ApiProperty({ type: 'boolean', example: false })
  isSubscribeTopic!: boolean;

  @ApiProperty({ format: 'uuid', example: 'topic-uuid-1234' })
  id!: string;

  @ApiPropertyOptional({ nullable: true, format: 'uuid', example: 'network-uuid-1234' })
  networkId?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'Latest in tech, code, and AI.' })
  description?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'https://cdn.brainboost.com/topics/technology.png',
  })
  iconUrl?: string | null;

  @ApiProperty({ type: 'boolean', example: true })
  isActive!: boolean;

  @ApiProperty({ format: 'date-time', example: '2023-01-01T00:00:00.000Z' })
  createdAt!: string;
}

export class TopicSubscribeBodyDto {
  @ApiProperty({
    example: 'topic-uuid-1234',
    description: 'Topic UUID or legacyId (int as string).',
  })
  topicId!: string;

  @ApiPropertyOptional({
    enum: ['subscribe', 'unsubscribe'],
    example: 'subscribe',
    description: 'Defaults to `subscribe` when omitted.',
  })
  action?: string;
}

export class TopicSubscribeResultDto {
  @ApiProperty({ type: 'integer', nullable: true, example: 42 })
  memberId!: number | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 7 })
  topicId!: number | null;

  @ApiProperty({
    type: 'boolean',
    example: true,
    description: 'New subscription state. False for PENDING (PRIVATE topic) and unsubscribe.',
  })
  isSubscribeTopic!: boolean;

  @ApiProperty({
    enum: ['APPROVED', 'PENDING', 'UNSUBSCRIBED'],
    example: 'APPROVED',
    description:
      'APPROVED for PUBLIC subscribe; PENDING for PRIVATE topic awaiting admin; UNSUBSCRIBED on unsubscribe.',
  })
  status!: string;

  @ApiProperty({ enum: ['subscribe', 'unsubscribe'], example: 'subscribe' })
  action!: string;
}
