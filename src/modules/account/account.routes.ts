import { Router } from 'express';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { authGuard } from '@/common/middlewares/auth.middleware';
import { asyncHandler } from '@/common/utils/async-handler';

export function accountRoutes(): Router {
  const router = Router();
  const ctrl = new AccountController(new AccountService());

  router.post('/account/preRegistration', asyncHandler(ctrl.preRegistration));
  router.post('/account/logout', authGuard, asyncHandler(ctrl.logout));
  router.post('/account/changePassword', authGuard, asyncHandler(ctrl.changePassword));
  router.get('/account/getPaymentToken', authGuard, asyncHandler(ctrl.getPaymentToken));
  router.post('/account/requestDeleteAccount', authGuard, asyncHandler(ctrl.requestDeleteAccount));
  router.post(
    '/account/verificationDeleteAccount',
    authGuard,
    asyncHandler(ctrl.verificationDeleteAccount),
  );
  router.post(
    '/account/recoverAccountScheduled',
    authGuard,
    asyncHandler(ctrl.recoverAccountScheduled),
  );

  return router;
}
