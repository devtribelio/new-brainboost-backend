import type { Request, Response } from 'express';
import { ShopVisitService } from '@bb/domain/shop/visit.service';
import { ok, okCreated } from '@bb/common/utils/response.util';
import { unauthorized } from '@bb/common/exceptions';
import { ERROR_CODES } from '@bb/common/exceptions';
import { clientIp } from '@bb/common/utils/client-ip.util';
import type { AuthenticatedRequest } from '@bb/common/interfaces/authenticated-request';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@bb/common/openapi/decorators';
import {
  ClaimShopVisitDto,
  LogShopVisitDto,
  ShopVisitClaimResultDto,
  ShopVisitResultDto,
} from './dto/shop-visit.dto';

@ApiTags('Shop')
export class ShopController {
  constructor(private readonly visitService: ShopVisitService) {}

  @ApiOperation({
    summary: 'Log a tracking-link visit (public)',
    description:
      'Always answers 200 — a marketing link that returns 4xx/5xx loses the click it exists to measure. Unusable input is reported as `status: "invalid"`, never as an error status code.',
  })
  @ApiBody({ type: () => LogShopVisitDto })
  @ApiResponse({ status: 200, type: () => ShopVisitResultDto })
  logVisit = async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

    const result = await this.visitService.logVisit({
      guestId: str(body.guestId),
      productCode: str(body.productCode),
      // The shop calls this before login; a bearer is never attached. memberId
      // is filled later by /shop/visits/claim.
      memberId: null,
      utmSource: str(body.utmSource),
      utmMedium: str(body.utmMedium),
      utmCampaign: str(body.utmCampaign),
      utmContent: str(body.utmContent),
      utmTerm: str(body.utmTerm),
      // Body wins over the header: the shop is a same-origin SPA, so its own
      // Referer is the shop page, not the ad/shortlink the visitor came from.
      referer: str(body.referer) ?? str(req.headers.referer),
      ipAddress: clientIp(req),
      userAgent: str(req.headers['user-agent']),
      clientEventId: str(body.clientEventId),
    });

    return ok(res, result);
  };

  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Bind this guest\'s visits to the logged-in member',
    description:
      'Call once after ANY successful auth — email register, password login, or Google. Idempotent.',
  })
  @ApiBody({ type: () => ClaimShopVisitDto })
  @ApiResponse({ status: 201, type: () => ShopVisitClaimResultDto })
  claimVisits = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw unauthorized(ERROR_CODES.AUTH_REQUIRED);
    const { guestId } = req.body as ClaimShopVisitDto;
    const result = await this.visitService.claimForMember(req.user.id, guestId);
    return okCreated(res, result);
  };
}
