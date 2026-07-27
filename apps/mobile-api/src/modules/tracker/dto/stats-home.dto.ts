import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

/** One active-program challenge card (spec §5.2 `challenges[]`). */
export class ChallengeDto {
  @ApiProperty({ format: 'uuid' })
  courseId!: string;

  @ApiPropertyOptional({ nullable: true, example: 'STOPSMOKE', description: 'Course code (Product.code)' })
  code!: string | null;

  @ApiProperty({ example: 'Stop Smoking' })
  title!: string;

  @ApiProperty({ type: 'integer', example: 7, description: 'Current consecutive-day streak for this program' })
  day!: number;

  @ApiProperty({ type: 'integer', example: 90, description: 'Program duration in days (Course.programDays)' })
  target!: number;
}

/** Current-week recap block (spec §5.2 `weeklyRecap`). */
export class WeeklyRecapDto {
  @ApiProperty({ type: 'integer', example: 2, description: 'Week number since member join (WIB, Monday start)' })
  weekNumber!: number;

  @ApiProperty({ type: 'integer', example: 6 })
  daysActive!: number;

  @ApiProperty({ type: 'integer', example: 7 })
  daysTarget!: number;

  @ApiProperty({ type: 'integer', example: 7 })
  streakDays!: number;

  @ApiProperty({ type: 'integer', example: 22500 })
  listenSec!: number;
}

/** One day of the current-week streak strip (spec §1 / BB-112). */
export class WeeklyStreakEntryDto {
  @ApiProperty({ example: '2026-07-20', description: 'Calendar day (YYYY-MM-DD) in WIB' })
  date!: string;

  @ApiProperty({ type: 'boolean', example: true, description: 'True when audio listened that day ≥ qualifyThresholdSec' })
  qualified!: boolean;
}

/** Response payload (inner `data`) for `GET /api/user/stats/home` (spec §5.2). */
export class StatsHomeDto {
  @ApiProperty({ type: 'integer', example: 7 })
  streakDays!: number;

  @ApiProperty({ type: 'integer', example: 23, description: 'Lifetime count of sessions ≥ MIN_SESSION_SEC' })
  sessionsPlayed!: number;

  @ApiProperty({ type: 'integer', example: 22500, description: 'Lifetime total seconds listened' })
  totalListenSec!: number;

  @ApiProperty({ type: 'array', itemType: () => ChallengeDto })
  challenges!: ChallengeDto[];

  @ApiPropertyOptional({ type: () => WeeklyRecapDto })
  weeklyRecap!: WeeklyRecapDto;

  @ApiProperty({
    type: 'array',
    itemType: () => WeeklyStreakEntryDto,
    description: 'Exactly 7 entries, Monday→Sunday of the current WIB week',
  })
  weeklyStreak!: WeeklyStreakEntryDto[];

  @ApiProperty({ example: '2026-07-24', description: "Today (YYYY-MM-DD) in WIB — client shouldn't rely on device clock" })
  today!: string;

  @ApiProperty({ type: 'integer', example: 600, description: 'Seconds/day threshold for a day to qualify (MIN_QUALIFY_SEC)' })
  qualifyThresholdSec!: number;
}
