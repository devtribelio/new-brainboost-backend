import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

/**
 * Wire shape for `serializeNotification()` per FE NotificationModel (audit #32).
 * Backend-native extras (id/body/seenAt/createdAt/notifGroup) dropped; `payload`
 * is exposed so the FE reads refTable/refId (and event fields) straight from it.
 */
export class NotificationDto {
  @ApiProperty({
    format: 'uuid',
    example: 'notification-uuid-1234',
    description: 'UUID until Notification gets a legacyId column (follow-up).',
  })
  notificationId!: string;

  @ApiProperty({ example: 'New comment on your post' })
  title!: string;

  @ApiProperty({
    example: 'John replied: "Great insights, thanks for sharing!"',
    description: 'Notification body (FE field name).',
  })
  message!: string;

  @ApiProperty({ type: 'integer', enum: [0, 1], example: 0 })
  isSeen!: number;

  @ApiProperty({ format: 'date-time', example: '2026-05-11T12:00:00.000Z' })
  created!: string;

  @ApiProperty({
    format: 'date-time',
    example: '2026-05-11T12:05:00.000Z',
    description: 'readAt timestamp; falls back to created when not yet read.',
  })
  updated!: string;

  @ApiPropertyOptional({
    nullable: true,
    type: 'object',
    example: { refTable: 'comment', refId: 'comment-uuid-1234', actorId: 'member-uuid-5678' },
    description: 'Raw notification payload (refTable/refId + event-specific fields).',
  })
  payload?: Record<string, unknown> | null;

  @ApiPropertyOptional({ nullable: true, example: 'comment_reply' })
  type?: string | null;
}

export class NotificationSeenDto {
  @ApiPropertyOptional({
    format: 'uuid',
    example: 'notification-uuid-1234',
    description: 'Mark a single notification as seen.',
  })
  notificationId?: string;

  @ApiPropertyOptional({
    type: 'array',
    itemType: 'string',
    example: ['notification-uuid-1234', 'notification-uuid-5678'],
    description: 'Mark several notifications as seen.',
  })
  notificationIds?: string[];

  @ApiPropertyOptional({
    type: 'boolean',
    example: true,
    description: 'Mark ALL my notifications as seen. Overrides the id fields.',
  })
  markAllRead?: boolean;
}

export class NotificationSeenResultDto {
  @ApiProperty({ type: 'integer', example: 3, description: 'Number of notification rows updated' })
  updated!: number;
}
