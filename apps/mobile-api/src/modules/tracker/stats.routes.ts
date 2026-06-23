import { Router } from 'express';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';
import { authGuard } from '@bb/common/middlewares/auth.middleware';
import { bindRoute } from '@bb/common/openapi/route-binder';

export function statsRoutes(): Router {
  const router = Router();
  const ctrl = new StatsController(new StatsService());

  bindRoute({
    router,
    controller: ctrl,
    method: 'get',
    path: '/stats/home',
    handlerKey: 'home',
    middlewares: [authGuard],
  });

  return router;
}
