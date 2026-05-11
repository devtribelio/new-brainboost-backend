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
    example: 'image',
    description: 'Always `image` when icon is set, otherwise null',
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

export class TopicPageDto {
  @ApiProperty({ type: 'integer', example: 42 })
  total!: number;

  @ApiProperty({ type: 'integer', example: 20 })
  perPage!: number;

  @ApiProperty({ type: 'integer', example: 1 })
  currentPage!: number;

  @ApiProperty({ type: 'integer', example: 3 })
  lastPage!: number;

  @ApiProperty({ type: 'array', itemType: () => TopicDto })
  items!: TopicDto[];
}

export class TopicSubscribeResultDto {
  @ApiProperty({ format: 'uuid', example: 'topic-uuid-1234' })
  topicId!: string;

  @ApiProperty({
    enum: ['APPROVED', 'PENDING'],
    example: 'APPROVED',
    description: 'APPROVED for PUBLIC topics; PENDING when a PRIVATE topic requires admin approval',
  })
  status!: string;

  @ApiPropertyOptional({ type: 'boolean', example: false })
  alreadySubscribed?: boolean;

  @ApiPropertyOptional({ type: 'boolean', example: false })
  alreadyRequested?: boolean;

  @ApiPropertyOptional({ type: 'boolean', example: false })
  unsubscribed?: boolean;

  @ApiProperty({ enum: ['subscribe', 'unsubscribe'], example: 'subscribe' })
  action!: string;
}
