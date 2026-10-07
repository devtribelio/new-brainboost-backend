import type { Request, Response } from 'express';
import type { AffiliatorService } from '@bb/domain/affiliate/affiliator.service';
import { ok } from '@bb/common/utils/response.util';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@bb/common/openapi/decorators';
import { PromoService } from './promo.service';
import { serializePromo } from './promo.serializer';
import { PromoDto } from './dto/promo.dto';

@ApiTags('Promo')
export class PromoController {
  constructor(
    private readonly promoService: PromoService,
    private readonly affiliatorService: AffiliatorService,
  ) {}

  @ApiOperation({
    summary: 'Active promos with their products',
    description:
      'Every promo running right now, in display order. Auth is optional: with a token `isPurchased` reflects the member. An empty list is a normal answer.',
  })
  @ApiQuery({
    name: 'platform',
    type: 'string',
    required: false,
    example: 'android',
    description:
      'Client platform (`android` | `ios`). Mobile only — selects the `promo.minVersion*` / `promo.maxVersion*` window. Omit (web) and no gate applies.',
  })
  @ApiQuery({
    name: 'version',
    type: 'string',
    required: false,
    example: '3.3.2',
    description:
      'Installed app version (semver). With a window configured for `platform`, promos are returned only when min <= version <= max (inclusive); a missing or unparseable version gets an empty list.',
  })
  @ApiResponse({ status: 200, type: () => PromoDto, isArray: true })
  listPublic = async (req: Request, res: Response) => {
    const memberId = (req as { user?: { id?: string } }).user?.id;
    // Read raw, not via validateDto: a junk value must never turn the list into a 400.
    const query = req.query as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    const { promos, ratingAvgByProduct, purchasedProductIds } = await this.promoService.listActive(
      memberId,
      { platform: str(query.platform), version: str(query.version) },
    );
    // Same commission preview as `product/list/public`, so a card reads the same on both pages.
    const commissionRate =
      memberId && promos.length > 0
        ? await this.affiliatorService.getPerformanceRate(memberId)
        : undefined;
    return ok(
      res,
      promos.map((p) =>
        serializePromo(p, { ratingAvgByProduct, purchasedProductIds, commissionRate }),
      ),
    );
  };
}
