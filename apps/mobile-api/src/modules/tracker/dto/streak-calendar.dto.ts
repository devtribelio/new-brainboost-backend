import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

/**
 * One day of the streak calendar.
 *
 * Same `state` vocabulary as `weeklyStreak` and the headline `streak.state`, resolved
 * by the same helper, so a day in the dialog and the streak number that opened it can
 * never disagree.
 *
 * `future` is never emitted here: a day after `today` is omitted from `days` entirely
 * rather than labelled, which is the same rule that omits days before the member's
 * first tracked day. The client draws an omitted date as a plain number.
 */
export class StreakCalendarDayDto {
  @ApiProperty({ example: '2026-09-03', description: 'Listening day (YYYY-MM-DD) in WIB' })
  date!: string;

  @ApiProperty({
    example: 'burning',
    description:
      'burning = listened ≥ qualifyThresholdSec that day · at_risk = today, not there yet · ' +
      'dimmed = missed but bridged by grace · none = missed',
  })
  state!: string;
}

/**
 * Response payload (inner `data`) for `GET /api/user/stats/streak/calendar`.
 *
 * `today`, `earliestMonth`, `currentStreak`, `qualifyThresholdSec` and
 * `dayBoundaryHour` describe the MEMBER, not the page, so they come back on every
 * response including a request for a month long past. The client pages months and
 * decides from the month on screen whether an arrow is live — a March response
 * missing `earliestMonth` would strand the member with no way back.
 */
export class StreakCalendarDto {
  @ApiProperty({ example: '2026-09', description: 'The month this page covers (YYYY-MM)' })
  month!: string;

  @ApiProperty({ example: '2026-09-04', description: "Today's LISTENING day — never the device clock" })
  today!: string;

  @ApiProperty({
    type: 'array',
    itemType: () => StreakCalendarDayDto,
    description:
      'Only days the member could have listened on: nothing before their first tracked day, ' +
      'nothing after `today`. Empty for a month with no history and for a future month — both 200, not 404.',
  })
  days!: StreakCalendarDayDto[];

  @ApiProperty({ type: 'integer', example: 12, description: 'Days in this month with state `burning`' })
  qualifiedDays!: number;

  @ApiProperty({
    type: 'integer',
    example: 6,
    description:
      'Longest consecutive qualifying run inside this month. Clipped at the month edges, so a run ' +
      'spanning into the previous month reports only its tail here and can be smaller than `currentStreak`.',
  })
  longestRun!: number;

  @ApiProperty({
    type: 'integer',
    example: 12,
    description: 'Identical to `streakDays` on GET /user/stats/home — duplicated so a stale home payload cannot disagree with this dialog',
  })
  currentStreak!: number;

  @ApiPropertyOptional({
    nullable: true,
    example: '2026-03',
    description: 'First month with any listening history; null for a member who has never listened. Disables the back arrow.',
  })
  earliestMonth!: string | null;

  @ApiProperty({ type: 'integer', example: 600, description: 'Seconds/day threshold for a day to qualify' })
  qualifyThresholdSec!: number;

  @ApiProperty({ type: 'integer', example: 4, description: 'Hour (WIB) the listening day rolls over' })
  dayBoundaryHour!: number;
}
