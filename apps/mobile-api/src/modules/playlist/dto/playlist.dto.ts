import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

export class PlaylistItemDto {
  @ApiProperty({
    example: 'M2WYRVCUV6JB5',
    description: 'The slide that plays — same id space as tracking `audioId`',
  })
  audioId!: string;

  @ApiProperty({ format: 'uuid', example: 'lesson-uuid-1' })
  lessonId!: string;

  @ApiProperty({ format: 'uuid', example: 'course-uuid-1' })
  courseId!: string;

  @ApiProperty({
    example: 'BrainBoost Money Magnet',
    description:
      'Product title of the course this audio belongs to — not the lesson or slide title, so items from one course read alike.',
  })
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

  @ApiPropertyOptional({
    nullable: true,
    example: 'https://cdn.brainboost.id/course-thumb.jpg',
    description:
      "Course artwork, absolute URL. Repeats across items of one course by design. Sent for locked items too — it is public catalogue art, and it is what makes a shared playlist sell.",
  })
  coverUrl?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'zb22segg',
    description:
      "`products.code`. If the app's course route expects the human-readable form (`brainboost-bela-diri-1`) that is `products.slug`, a different column — say so and it is a one-line addition.",
  })
  courseCode?: string | null;
}

export class PlaylistDto {
  @ApiProperty({ format: 'uuid', example: 'playlist-uuid-1' })
  id!: string;

  @ApiProperty({ example: 'Pagi Fokus' })
  name!: string;

  @ApiPropertyOptional({ nullable: true, example: 'Rangkaian audio untuk memulai hari' })
  description?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'https://cdn.brainboost.id/cover.webp',
    description:
      "The playlist's own cover, or the first item's course artwork when unset — members have no UI to set one, so an unset cover would otherwise render grey everywhere.",
  })
  coverUrl?: string | null;

  @ApiProperty({
    type: 'array',
    itemType: 'string',
    description:
      'Up to 4 DISTINCT course covers, in order of first appearance, for a mosaic tile. Empty for an empty playlist; a single-course playlist yields one url, not four copies. `coverUrl` stays the single tile for the mini player and lock screen.',
  })
  coverUrls!: string[];

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

  @ApiPropertyOptional({
    nullable: true,
    example: 'k7Qm2xR9vTb0LpAe3ZsYdw',
    description:
      'Share token, present ONLY for a non-owner who has not saved this playlist — the handle to re-resolve it via /playlist/shared/{token}. null for the owner and for a viewer who already holds a copy.',
  })
  shareToken?: string | null;

  @ApiProperty({ type: () => [PlaylistItemDto] })
  items!: PlaylistItemDto[];
}
