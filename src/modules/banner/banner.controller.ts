import type { Request, Response } from 'express';
import { BannerService } from './banner.service';
import { ok } from '@/common/utils/response.util';
import { serializeBanner } from '@/common/serializers';

export class BannerController {
  constructor(private readonly bannerService: BannerService) {}

  list = async (_req: Request, res: Response) => {
    const banners = await this.bannerService.listActive();
    return ok(res, banners.map(serializeBanner));
  };
}
