import { Router } from 'express';
import { TrackingController } from './tracking.controller';
import { TrackingService } from './tracking.service';
import { authGuard } from '@bb/common/middlewares/auth.middleware';
import { validateDto } from '@bb/common/middlewares/validation.middleware';
import { bindRoute } from '@bb/common/openapi/route-binder';
import { TrackSessionDto } from './dto/track-session.dto';

export function trackingRoutes(): Router {
  const router = Router();
  const ctrl = new TrackingController(new TrackingService());

  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/session',
    handlerKey: 'session',
    middlewares: [authGuard, validateDto(TrackSessionDto)],
  });

  return router;
}
