import type { Response } from 'express';
import { TrackingService } from './tracking.service';
import { ok } from '@bb/common/utils/response.util';
import { UnauthorizedException } from '@bb/common/exceptions';
import type { AuthenticatedRequest } from '@bb/common/interfaces/authenticated-request';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@bb/common/openapi/decorators';
import { GenericOkDto } from '@bb/common/openapi/common.dto';
import { TrackSessionDto } from './dto/track-session.dto';

/** Read the client platform from the `x-platform` header (ios/android), else null. */
function platformFrom(req: AuthenticatedRequest): string | null {
  const raw = req.headers['x-platform'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === 'ios' || value === 'android' ? value : null;
}

@ApiTags('Tracker')
@ApiBearerAuth()
export class TrackingController {
  constructor(private readonly trackingService: TrackingService) {}

  @ApiOperation({ summary: 'Record a listening session (idempotent by clientSessionId)' })
  @ApiBody({ type: () => TrackSessionDto })
  @ApiResponse({ status: 200, type: () => GenericOkDto })
  session = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    await this.trackingService.record(
      req.user.id,
      req.body as TrackSessionDto,
      platformFrom(req),
    );
    return ok(res, { ok: true });
  };
}
