import { Router } from 'express';
import { NetworkController } from './network.controller';
import { NetworkService } from './network.service';
import { authGuard } from '@/common/middlewares/auth.middleware';
import { asyncHandler } from '@/common/utils/async-handler';

export function networkRoutes(): Router {
  const router = Router();
  const ctrl = new NetworkController(new NetworkService());

  router.post('/network/join', authGuard, asyncHandler(ctrl.join));
  router.get('/network/member', asyncHandler(ctrl.members));
  router.get('/network/tag', asyncHandler(ctrl.tags));

  return router;
}
