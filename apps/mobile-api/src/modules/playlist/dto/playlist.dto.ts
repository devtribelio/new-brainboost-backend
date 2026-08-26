import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

export class PlaylistItemDto {
  @ApiProperty({ format: 'uuid', example: 'lesson-uuid-1' })
  lessonId!: string;

  @ApiProperty({ format: 'uuid', example: 'course-uuid-1' })
  courseId!: string;

  @ApiProperty({ example: 'Fokus Pagi — Sesi 1' })
  name!: string;

  @ApiProperty({ type: 'integer', example: 612 })
  durationSec!: number;

  @ApiProperty({ type: 'integer', example: 1 })
  order!: number;

  @ApiProperty({
    type: 'boolean',
    example: false,
    description: 'True when the viewer may not play this audio. UI hint only — the real gate is /media/stream.',
  })
  locked!: boolean;

  @ApiPropertyOptional({
    nullable: true,
    example: '/api/member/media/stream?t=opaque-token',
    description: 'null when locked. TTL 2h — do not cache the response longer than that.',
  })
  streamUrl?: string | null;
}

export class PlaylistDto {
  @ApiProperty({ format: 'uuid', example: 'playlist-uuid-1' })
  id!: string;

  @ApiProperty({ example: 'Pagi Fokus' })
  name!: string;

  @ApiPropertyOptional({ nullable: true, example: 'Rangkaian audio untuk memulai hari' })
  description?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'https://cdn.brainboost.id/cover.webp' })
  coverUrl?: string | null;

  @ApiProperty({ example: 'PRIVATE', description: 'PRIVATE | UNLISTED' })
  visibility!: string;

  @ApiProperty({ type: 'integer', example: 8 })
  totalItems!: number;

  @ApiProperty({ type: 'integer', example: 0 })
  lockedItems!: number;

  @ApiProperty({ type: 'boolean', example: true })
  isOwner!: boolean;

  @ApiProperty({ format: 'date-time', example: '2026-08-24T10:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', example: '2026-08-24T10:00:00.000Z' })
  updatedAt!: string;
}

export class PlaylistDetailDto extends PlaylistDto {
  @ApiProperty({
    type: 'boolean',
    example: true,
    description: 'Whether the feature is currently subscriber-gated (app_settings kill-switch).',
  })
  requiresSubscription!: boolean;

  @ApiPropertyOptional({
    nullable: true,
    example: '/api/member/media/stream?t=opaque-token',
    description: 'Interlude clip played between items. null = interlude disabled.',
  })
  interludeStreamUrl?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: '__interlude__',
    description:
      'audioId to use IF the app reports the interlude to the tracker. Server drops it either way. null = interlude disabled.',
  })
  interludeAudioId?: string | null;

  @ApiProperty({ type: () => [PlaylistItemDto] })
  items!: PlaylistItemDto[];
}
