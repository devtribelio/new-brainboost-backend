import type { Response } from 'express';
import { isUUID } from 'class-validator';
import { StatsService } from './stats.service';
import { ok } from '@bb/common/utils/response.util';
import {
  BadRequestException,
  UnauthorizedException,
  unauthorized,
  ERROR_CODES,
} from '@bb/common/exceptions';
import type { AuthenticatedRequest } from '@bb/common/interfaces/authenticated-request';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@bb/common/openapi/decorators';
import { StatsHomeDto } from './dto/stats-home.dto';
import { CourseStatsDto } from './dto/course-stats.dto';

@ApiTags('Tracker')
@ApiBearerAuth()
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  @ApiOperation({
    summary: 'Home-screen stats: streak, sessions, total listened, challenges, weekly recap',
  })
  @ApiResponse({ status: 200, type: () => StatsHomeDto })
  home = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw unauthorized(ERROR_CODES.AUTH_REQUIRED);
    return ok(res, await this.statsService.home(req.user.id));
  };

  @ApiOperation({ summary: 'Per-course stats: streak, weekly strip, total listened, last listened (this course only)' })
  @ApiResponse({ status: 200, type: () => CourseStatsDto })
  courseStats = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const { courseId } = req.params;
    if (!isUUID(courseId)) throw new BadRequestException('Invalid courseId');
    return ok(res, await this.statsService.courseStats(req.user.id, courseId));
  };
}
