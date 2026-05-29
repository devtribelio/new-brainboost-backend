import { Router } from 'express';
import { NetworkController } from './network.controller';
import { NetworkService } from './network.service';
import { authGuard } from '@bb/common/middlewares/auth.middleware';
import { bindRoute } from '@bb/common/openapi/route-binder';

export function networkRoutes(): Router {
  const router = Router();
  const ctrl = new NetworkController(new NetworkService());

  bindRoute({ router, controller: ctrl, method: 'post', path: '/network/join', handlerKey: 'join', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/network/request/approve', handlerKey: 'approveRequest', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/network/request/reject', handlerKey: 'rejectRequest', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'get', path: '/network/member', handlerKey: 'members' });
  bindRoute({ router, controller: ctrl, method: 'get', path: '/network/tag', handlerKey: 'tags' });

  return router;
}
