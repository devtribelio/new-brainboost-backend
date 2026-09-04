import { IsOptional, IsString, Matches } from 'class-validator';
import { ApiPropertyOptional } from '@bb/common/openapi/decorators';

export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export class StreakCalendarQueryDto {
  @ApiPropertyOptional({
    example: '2026-09',
    description:
      'Month to render (YYYY-MM). Omitted means the month `today` falls in. A month with no history ' +
      'and a future month both answer 200 with an empty `days`; only a malformed value is a 400.',
  })
  @IsOptional()
  @IsString()
  @Matches(MONTH_PATTERN, { message: 'month must be YYYY-MM' })
  month?: string;
}
