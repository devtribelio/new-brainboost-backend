import {
  IsBoolean,
  IsInt,
  IsISO8601,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

/** Request body for `POST /api/tracking/session` (spec §5.1). */
export class TrackSessionDto {
  @ApiProperty({ format: 'uuid', description: 'Generated on device at play-start; idempotency key' })
  @IsUUID()
  clientSessionId!: string;

  @ApiProperty({ format: 'uuid', description: 'Lesson (audio) id' })
  @IsUUID()
  audioId!: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  courseId?: string | null;

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
