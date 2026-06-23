import type { Response } from 'express';
import { StatsService } from './stats.service';
import { ok } from '@bb/common/utils/response.util';
import { UnauthorizedException } from '@bb/common/exceptions';
import type { AuthenticatedRequest } from '@bb/common/interfaces/authenticated-request';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@bb/common/openapi/decorators';
import { StatsHomeDto } from './dto/stats-home.dto';

@ApiTags('Tracker')
@ApiBearerAuth()
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  @ApiOperation({ summary: 'Home-screen stats: streak, sessions, total listened, challenges, weekly recap' })
  @ApiResponse({ status: 200, type: () => StatsHomeDto })
  home = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    return ok(res, await this.statsService.home(req.user.id));
  };
}
