import { Router } from 'express';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';
import { authGuard } from '@/common/middlewares/auth.middleware';
import { bindRoute } from '@/common/openapi/route-binder';

export function notificationRoutes(): Router {
  const router = Router();
  const ctrl = new NotificationController(new NotificationService());

  bindRoute({ router, controller: ctrl, method: 'get', path: '/notification/list', handlerKey: 'list', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/notification/seen', handlerKey: 'seen', middlewares: [authGuard] });

  return router;
}
