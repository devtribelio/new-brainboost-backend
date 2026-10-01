import { traceService } from '@bb/common/utils/trace-service';
import { Router } from 'express';
import { PromoController } from './promo.controller';
import { PromoService } from './promo.service';
import { ProductService } from '@/modules/product/product.service';
import { AffiliatorService } from '@bb/domain/affiliate/affiliator.service';
import { optionalAuthGuard } from '@bb/common/middlewares/auth.middleware';
import { bindRoute } from '@bb/common/openapi/route-binder';

export function promoRoutes(): Router {
  const router = Router();
  const ctrl = new PromoController(
    traceService(new PromoService(new ProductService())),
    traceService(new AffiliatorService()),
  );

  bindRoute({
    router,
    controller: ctrl,
    method: 'get',
    path: '/promo/public',
    handlerKey: 'listPublic',
    middlewares: [optionalAuthGuard],
  });

  return router;
}
