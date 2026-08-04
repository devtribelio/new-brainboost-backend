import { Router } from 'express';
import { BonusController } from './bonus.controller';
import { BonusService } from './bonus.service';
import { authGuard } from '@bb/common/middlewares/auth.middleware';
import { bindRoute } from '@bb/common/openapi/route-binder';

export function bonusRoutes(): Router {
  const router = Router();
  const ctrl = new BonusController(new BonusService());

  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/course/bonus/:bonusId/access-url',
    handlerKey: 'accessUrl',
    middlewares: [authGuard],
  });

  return router;
}
