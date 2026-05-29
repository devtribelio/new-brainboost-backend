import { Router } from 'express';
import { NotificationController } from './notification.controller';
import { NotificationService } from '@bb/domain/notification/notification.service';
import { authGuard } from '@bb/common/middlewares/auth.middleware';
import { bindRoute } from '@bb/common/openapi/route-binder';

export function notificationRoutes(): Router {
  const router = Router();
  const ctrl = new NotificationController(new NotificationService());

  bindRoute({ router, controller: ctrl, method: 'get', path: '/notification/list', handlerKey: 'list', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/notification/seen', handlerKey: 'seen', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/notification/mute', handlerKey: 'mute', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/notification/unmute', handlerKey: 'unmute', middlewares: [authGuard] });

  return router;
}
