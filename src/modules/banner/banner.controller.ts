import type { Request, Response } from 'express';
import { BannerService } from './banner.service';
import { notImplemented } from '@/common/utils/response.util';

export class BannerController {
  constructor(private readonly _bannerService: BannerService) {}

  list = async (_req: Request, res: Response) => notImplemented(res, 'banner.list');
}
