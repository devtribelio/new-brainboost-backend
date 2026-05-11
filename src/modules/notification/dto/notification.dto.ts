import { ApiProperty, ApiPropertyOptional } from '@/common/openapi/decorators';

/**
 * Wire shape for `serializeNotification()` plus the per-row `notifGroup` (time bucket).
 */
export class NotificationDto {
  @ApiProperty({ format: 'uuid', example: 'notification-uuid-1234' })
  notificationId!: string;

  @ApiProperty({ example: 'New comment on your post' })
  title!: string;

  @ApiProperty({
    example: 'John replied: "Great insights, thanks for sharing!"',
    description: 'Legacy alias of `body`',
  })
  message!: string;

  @ApiProperty({ type: 'boolean', example: false })
  isSeen!: boolean;

  @ApiProperty({ format: 'date-time', example: '2026-05-11T12:00:00.000Z' })
  created!: string;

  @ApiPropertyOptional({ nullable: true, example: null })
  updated?: string | null;

  @ApiPropertyOptional({ nullable: true, example: null })
  refTable?: string | null;

  @ApiPropertyOptional({ nullable: true, example: null })
  refId?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'comment_reply' })
  type?: string | null;

  @ApiProperty({ format: 'uuid', example: 'notification-uuid-1234' })
  id!: string;

  @ApiProperty({ example: 'John replied: "Great insights, thanks for sharing!"' })
  body!: string;

  @ApiPropertyOptional({
    type: 'object',
    nullable: true,
    example: { postId: 'post-uuid', commentId: 'comment-uuid' },
  })
  payload?: unknown;

  @ApiPropertyOptional({
    nullable: true,
    format: 'date-time',
    example: '2026-05-11T12:05:00.000Z',
  })
  seenAt?: string | null;

  @ApiProperty({ format: 'date-time', example: '2026-05-11T12:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({
    enum: ['today', 'yesterday', 'thisWeek', 'earlier'],
    example: 'today',
    description: 'UI grouping bucket based on createdAt',
  })
  notifGroup!: string;
}

export class NotificationPageDto {
  @ApiProperty({ type: 'integer', example: 12 })
  total!: number;

  @ApiPropertyOptional({
    type: 'integer',
    example: 84,
    description: 'Total across all filter groups (present when group filter applied)',
  })
  totalAll?: number;

  @ApiProperty({ type: 'integer', example: 20 })
  perPage!: number;

  @ApiProperty({ type: 'integer', example: 1 })
  currentPage!: number;

  @ApiProperty({ type: 'integer', example: 1 })
  lastPage!: number;

  @ApiProperty({ type: 'array', itemType: () => NotificationDto })
  items!: NotificationDto[];

  @ApiProperty({ type: 'integer', example: 4, description: 'Unread count for the member' })
  unread!: number;
}

export class NotificationSeenResultDto {
  @ApiProperty({ type: 'integer', example: 3, description: 'Number of notification rows updated' })
  updated!: number;
}
