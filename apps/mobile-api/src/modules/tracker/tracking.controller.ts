import type { Response } from 'express';
import { TrackingService } from './tracking.service';
import { ok } from '@bb/common/utils/response.util';
import { unauthorized, ERROR_CODES } from '@bb/common/exceptions';
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

/**
 * Provenance of a session row, from the `x-platform` header.
 *
 * Accepts a bare platform (`ios`) or a platform + build (`android/3.3.1+412`).
 * The build matters: without it a report of "streak broke after the update" cannot
 * be checked against the data at all, which is exactly what happened in Aug 2026.
 *
 * Anything else becomes null rather than being stored — `source` also carries
 * synthetic markers (`backfill:*`, `goodwill:*`) that must never be forgeable from
 * a request header.
 */
const SOURCE_PATTERN = /^(ios|android)(\/[\w.+-]{1,32})?$/;

function platformFrom(req: AuthenticatedRequest): string | null {
  const raw = req.headers['x-platform'];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value && SOURCE_PATTERN.test(value) ? value : null;
}

@ApiTags('Tracker')
@ApiBearerAuth()
export class TrackingController {
  constructor(private readonly trackingService: TrackingService) {}

  @ApiOperation({ summary: 'Record a listening session (idempotent by clientSessionId)' })
  @ApiBody({ type: () => TrackSessionDto })
  @ApiResponse({ status: 200, type: () => GenericOkDto })
  session = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw unauthorized(ERROR_CODES.AUTH_REQUIRED);
    await this.trackingService.record(req.user.id, req.body as TrackSessionDto, platformFrom(req));
    return ok(res, { ok: true });
  };
}
