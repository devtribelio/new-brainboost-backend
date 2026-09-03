import { Router } from 'express';
import { traceService } from '@bb/common/utils/trace-service';
import { ShopVisitService } from '@bb/domain/shop/visit.service';
import { authGuard } from '@bb/common/middlewares/auth.middleware';
import { validateDto } from '@bb/common/middlewares/validation.middleware';
import { shopVisitRateLimiter } from '@bb/common/middlewares/rate-limit.middleware';
import { bindRoute } from '@bb/common/openapi/route-binder';
import { ShopController } from './shop.controller';
import { ClaimShopVisitDto } from './dto/shop-visit.dto';

export function shopRoutes(): Router {
  const router = Router();
  const ctrl = new ShopController(traceService(new ShopVisitService()));

  // Public, unauthenticated. No validateDto on purpose — a 400 on a marketing
  // link is a lost visit; bad input comes back 200 with status "invalid".
  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/visits',
    handlerKey: 'logVisit',
    middlewares: [shopVisitRateLimiter],
  });

  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/visits/claim',
    handlerKey: 'claimVisits',
    middlewares: [authGuard, validateDto(ClaimShopVisitDto)],
  });

  return router;
}
