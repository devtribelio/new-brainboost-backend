import type { Request, Response } from 'express';
import { BannerService } from './banner.service';
import { okPaginated } from '@bb/common/utils/response.util';
import { parsePagination } from '@bb/common/utils/pagination.util';
import { serializeBanner } from './banner.serializer';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@bb/common/openapi/decorators';
import { BannerDto } from './dto/banner.dto';

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
      "Client platform (`android` | `ios`). Selects which `banner.maxVersion*` setting gates the response. Omit and no gate applies.",
  })
  @ApiQuery({
    name: 'version',
    type: 'string',
    required: false,
    example: '3.3.0',
    description:
      'Installed app version (semver). Banners are returned up to and INCLUDING the configured max version; a strictly newer build gets an empty list. Omitted/unparseable = shown.',
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
      { platform: str(query.platform), version: str(query.version) },
    );
    return okPaginated(res, rows.map(serializeBanner), { page: p.page, perPage: p.perPage, total });
  };
}
