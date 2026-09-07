import { ApiProperty } from '@bb/common/openapi/decorators';
import { WeeklyStreakEntryDto } from './stats-home.dto';

/**
 * Response payload (inner `data`) for `GET /api/user/stats/course/:courseId`
 * (spec §2 / BB-114). Per-course listening stats — pure audio for THIS course
 * (no video-OR union). A never-listened course returns zeros/null, not 404.
 *
 * Every field is scoped to the CALLING member. `daysListened` is "how many days I
 * really listened to this course", not how many people did.
 */
export class CourseStatsDto {
  @ApiProperty({ format: 'uuid', description: 'Echo of the path param (course UUID)' })
  courseId!: string;

  @ApiProperty({
    type: 'integer',
    example: 12,
    description:
      'How many listening days this member has on this course — days where their ' +
      'audio for THIS course summed to at least MIN_QUALIFY_SEC (10 min). Cumulative ' +
      'across the day, not one unbroken sitting: 5+3+2 min counts. The day runs ' +
      '04:00→03:59 WIB, so a session at 23:50 and one at 00:10 land on the same day. ' +
      'Same rule the streak uses, so this number can never contradict the flame.',
  })
  daysListened!: number;

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
