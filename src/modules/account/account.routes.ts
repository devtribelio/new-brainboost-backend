import { Router } from 'express';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { authGuard } from '@/common/middlewares/auth.middleware';
import { bindRoute } from '@/common/openapi/route-binder';

export function accountRoutes(): Router {
  const router = Router();
  const ctrl = new AccountController(new AccountService());

  bindRoute({ router, controller: ctrl, method: 'post', path: '/account/preRegistration', handlerKey: 'preRegistration' });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/account/logout', handlerKey: 'logout', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/account/changePassword', handlerKey: 'changePassword', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'get', path: '/account/getPaymentToken', handlerKey: 'getPaymentToken', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/account/requestDeleteAccount', handlerKey: 'requestDeleteAccount', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/account/verificationDeleteAccount', handlerKey: 'verificationDeleteAccount', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/account/recoverAccountScheduled', handlerKey: 'recoverAccountScheduled', middlewares: [authGuard] });

  return router;
}
