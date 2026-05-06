import { Router } from 'express';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';
import { authGuard } from '@/common/middlewares/auth.middleware';
import { asyncHandler } from '@/common/utils/async-handler';

export function profileRoutes(): Router {
  const router = Router();
  const ctrl = new ProfileController(new ProfileService());

  router.get('/account/profile/info', authGuard, asyncHandler(ctrl.getInfo));
  router.post('/account/profile/update', authGuard, asyncHandler(ctrl.update));
  router.post('/account/profile/location', authGuard, asyncHandler(ctrl.updateLocation));

  return router;
}
