import { Router } from 'express';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';
import { authGuard } from '@/common/middlewares/auth.middleware';
import { asyncHandler } from '@/common/utils/async-handler';

export function notificationRoutes(): Router {
  const router = Router();
  const ctrl = new NotificationController(new NotificationService());

  router.get('/notification/list', authGuard, asyncHandler(ctrl.list));
  router.post('/notification/seen', authGuard, asyncHandler(ctrl.seen));

  return router;
}
