import type { Request, Response } from 'express';
import { BannerService } from './banner.service';
import { ok } from '@/common/utils/response.util';
import { serializeBanner } from '@/common/serializers';
import { ApiOperation, ApiResponse, ApiTags } from '@/common/openapi/decorators';

@ApiTags('Banner')
export class BannerController {
  constructor(private readonly bannerService: BannerService) {}

  @ApiOperation({ summary: 'List active banners' })
  @ApiResponse({ status: 200, description: 'Active banners (ordered by position)' })
  list = async (_req: Request, res: Response) => {
    const banners = await this.bannerService.listActive();
    return ok(res, banners.map(serializeBanner));
  };
}
