import type { Request, Response } from 'express';
import { BannerService } from './banner.service';
import { okPaginated } from '@bb/common/utils/response.util';
import { parsePagination } from '@bb/common/utils/pagination.util';
import { serializeBanner } from './banner.serializer';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@bb/common/openapi/decorators';
import { BannerDto } from './dto/banner.dto';
import { verifyAccessToken } from '@bb/common/utils/jwt.util';

/**
 * Member id from a bearer token if one is present and valid, else undefined. The
 * endpoint stays public: this only lets promo banners be hidden for B2B-managed
 * members. Deliberately not `optionalAuthGuard` — that also resets the unopened-
 * push counter, which a banner fetch must not do.
 */
function bearerMemberId(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header?.toLowerCase().startsWith('bearer ')) return undefined;
  try {
    const payload = verifyAccessToken(header.slice(7).trim());
    return (payload.scope ?? 'member') === 'member' ? payload.sub : undefined;
  } catch {
    return undefined;
  }
}

@ApiTags('Banner')
export class BannerController {
  constructor(private readonly bannerService: BannerService) {}

  @ApiOperation({ summary: 'List active banners' })
  @ApiQuery({ name: 'page', type: 'integer', required: false, example: 1 })
  @ApiQuery({ name: 'perPage', type: 'integer', required: false, example: 3 })
  @ApiQuery({ name: 'isPopup', type: 'boolean', required: false, example: true })
  @ApiQuery({
    name: 'platform',
    type: 'string',
    required: false,
    example: 'android',
    description:
      "Client platform (`android` | `ios`). Selects which `banner.maxVersion*` setting gates the response, and which per-banner version window applies. Omit and the global gate does not apply, but banners that carry a version window are left out.",
  })
  @ApiQuery({
    name: 'version',
    type: 'string',
    required: false,
    example: '3.3.0',
    description:
      'Installed app version (semver). Banners are returned up to and INCLUDING the configured max version; a strictly newer build gets an empty list. Omitted/unparseable = shown, except banners with their own version window (min/max per platform, inclusive), which are shown only when the version is inside it.',
  })
  @ApiResponse({
    status: 200,
    description: 'Active banners (paginated, ordered by position)',
    type: () => BannerDto,
    isArray: true,
    envelope: 'paginated',
  })
  list = async (req: Request, res: Response) => {
    const query = req.query as Record<string, unknown>;
    const p = parsePagination(query, { perPage: 3 });
    const raw = query.isPopup;
    const isPopup = raw === undefined ? undefined : raw === 'true' || raw === '1';
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    const { rows, total } = await this.bannerService.listActive(
      p,
      { isPopup },
      { platform: str(query.platform), version: str(query.version), memberId: bearerMemberId(req) },
    );
    return okPaginated(res, rows.map(serializeBanner), { page: p.page, perPage: p.perPage, total });
  };
}
