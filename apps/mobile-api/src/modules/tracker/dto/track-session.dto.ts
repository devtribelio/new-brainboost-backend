import { IsBoolean, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

/** Request body for `POST /api/tracking/session` (spec §5.1). */
export class TrackSessionDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Generated on device at play-start; idempotency key',
  })
  @IsUUID()
  clientSessionId!: string;

  @ApiProperty({ description: 'Lesson (audio) id — opaque string, not validated as UUID' })
  @IsString()
  audioId!: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  courseId?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description:
      'Playlist the audio was played from, when any. Feeds the recent/top playlist lists; omit for standalone listening.',
  })
  @IsOptional()
  @IsUUID()
  playlistId?: string | null;

  @ApiProperty({ format: 'date-time', example: '2026-06-23T01:10:00Z' })
  @IsISO8601()
  startedAt!: string;

  @ApiProperty({
    type: 'integer',
    example: 845,
    description: 'Accumulated seconds actually heard (not audio duration). Capped at 24h.',
  })
  @IsInt()
  @Min(0)
  @Max(86_400)
  listenedSec!: number;

  @ApiProperty({ type: 'boolean', example: true })
  @IsBoolean()
  completed!: boolean;
}
