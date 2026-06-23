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
}
