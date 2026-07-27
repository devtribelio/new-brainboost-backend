import { ApiProperty } from '@bb/common/openapi/decorators';
import { WeeklyStreakEntryDto } from './stats-home.dto';

/**
 * Response payload (inner `data`) for `GET /api/user/stats/course/:courseId`
 * (spec §2 / BB-114). Per-course listening stats — pure audio for THIS course
 * (no video-OR union). A never-listened course returns zeros/null, not 404.
 */
export class CourseStatsDto {
  @ApiProperty({ format: 'uuid', description: 'Echo of the path param (course UUID)' })
  courseId!: string;

  @ApiProperty({ type: 'integer', example: 12, description: 'Current consecutive-day streak for this course (WIB)' })
  streak!: number;

  @ApiProperty({
    type: 'array',
    itemType: () => WeeklyStreakEntryDto,
    description: 'Exactly 7 entries, Monday→Sunday of the current WIB week, for this course only',
  })
  weeklyStreak!: WeeklyStreakEntryDto[];

  @ApiProperty({ type: 'integer', example: 45600, description: 'Lifetime seconds listened for this course' })
  totalListenSec!: number;

  @ApiProperty({
    nullable: true,
    example: '2026-07-22T14:14:00.000Z',
    description: 'Last session start (UTC ISO-8601), or null if never listened',
  })
  lastListenedAt!: string | null;
}
