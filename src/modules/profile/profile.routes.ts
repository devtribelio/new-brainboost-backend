import { Router } from 'express';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';
import { authGuard } from '@bb/common/middlewares/auth.middleware';
import { bindRoute } from '@bb/common/openapi/route-binder';

export function profileRoutes(): Router {
  const router = Router();
  const ctrl = new ProfileController(new ProfileService());

  bindRoute({ router, controller: ctrl, method: 'get', path: '/account/profile/info', handlerKey: 'getInfo', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/account/profile/update', handlerKey: 'update', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/account/profile/location', handlerKey: 'updateLocation', middlewares: [authGuard] });

  return router;
}
