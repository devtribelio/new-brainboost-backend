import { Router } from 'express';
import { BannerController } from './banner.controller';
import { BannerService } from './banner.service';
import { asyncHandler } from '@/common/utils/async-handler';

export function bannerRoutes(): Router {
  const router = Router();
  const ctrl = new BannerController(new BannerService());

  router.get('/data/banner', asyncHandler(ctrl.list));

  return router;
}
