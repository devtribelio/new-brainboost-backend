import type { Request, Response } from 'express';
import { BannerService } from './banner.service';
import { okLegacy } from '@/common/utils/response.util';
import { parsePagination } from '@/common/utils/pagination.util';
import { serializeBanner } from '@/common/serializers';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@/common/openapi/decorators';
import { BannerPageDto } from './dto/banner.dto';

@ApiTags('Banner')
export class BannerController {
  constructor(private readonly bannerService: BannerService) {}

  @ApiOperation({ summary: 'List active banners (FE legacy http envelope)' })
  @ApiQuery({ name: 'page', type: 'integer', required: false, example: 1 })
  @ApiQuery({ name: 'perPage', type: 'integer', required: false, example: 3 })
  @ApiResponse({
    status: 200,
    description: 'Active banners (paginated, ordered by position)',
    type: () => BannerPageDto,
    envelope: 'none',
  })
  list = async (req: Request, res: Response) => {
    const p = parsePagination(req.query as Record<string, unknown>, { perPage: 3 });
    const { rows, total } = await this.bannerService.listActive(p);
    return okLegacy(res, rows.map(serializeBanner), total, p.page, p.perPage);
  };
}
