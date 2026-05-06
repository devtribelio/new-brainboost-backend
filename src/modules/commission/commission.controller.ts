import type { Response } from 'express';
import { CommissionService } from './commission.service';
import { ok } from '@/common/utils/response.util';
import { UnauthorizedException } from '@/common/exceptions';
import type { AuthenticatedRequest } from '@/common/interfaces/authenticated-request';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@/common/openapi/decorators';

@ApiTags('Commission')
@ApiBearerAuth()
export class CommissionController {
  constructor(private readonly commissionService: CommissionService) {}

  @ApiOperation({ summary: 'Aggregated commission summary + recent entries' })
  @ApiResponse({ status: 200 })
  summary = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    return ok(res, await this.commissionService.summary(req.user.id));
  };
}
