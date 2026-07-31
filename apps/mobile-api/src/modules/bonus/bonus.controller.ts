import type { Response } from 'express';
import { isUUID } from 'class-validator';
import { BonusService } from './bonus.service';
import { ok } from '@bb/common/utils/response.util';
import { badRequest, ERROR_CODES, UnauthorizedException } from '@bb/common/exceptions';
import type { AuthenticatedRequest } from '@bb/common/interfaces/authenticated-request';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@bb/common/openapi/decorators';
import { BonusAccessUrlDto } from './bonus.dto';

@ApiTags('Bonus')
@ApiBearerAuth()
export class BonusController {
  constructor(private readonly bonusService: BonusService) {}

  @ApiOperation({ summary: 'Mint a short-lived presigned URL for a course bonus PDF (course access required)' })
  @ApiResponse({ status: 200, type: () => BonusAccessUrlDto })
  @ApiResponse({ status: 403, description: 'No access to the course this bonus belongs to' })
  @ApiResponse({ status: 404, description: 'Bonus not found' })
  accessUrl = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const { bonusId } = req.params;
    if (!isUUID(bonusId)) throw badRequest(ERROR_CODES.BONUS_ID_INVALID);
    return ok(res, await this.bonusService.getAccessUrl(req.user.id, bonusId));
  };
}
