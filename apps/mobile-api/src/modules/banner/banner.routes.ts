import { Router } from 'express';
import { BannerController } from './banner.controller';
import { BannerService } from './banner.service';
import { bindRoute } from '@bb/common/openapi/route-binder';

export function bannerRoutes(): Router {
  const router = Router();
  const ctrl = new BannerController(new BannerService());

  bindRoute({ router, controller: ctrl, method: 'get', path: '/data/banner', handlerKey: 'list' });

  return router;
}
