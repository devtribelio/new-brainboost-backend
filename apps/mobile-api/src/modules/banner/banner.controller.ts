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
  @ApiResponse({
    status: 200,
    description: 'Active banners (paginated, ordered by position)',
    type: () => BannerDto,
    isArray: true,
    envelope: 'paginated',
  })
  list = async (req: Request, res: Response) => {
    const p = parsePagination(req.query as Record<string, unknown>, { perPage: 3 });
    const raw = (req.query as Record<string, unknown>).isPopup;
    const isPopup = raw === undefined ? undefined : raw === 'true' || raw === '1';
    const { rows, total } = await this.bannerService.listActive(p, { isPopup });
    return okPaginated(res, rows.map(serializeBanner), { page: p.page, perPage: p.perPage, total });
  };
}
