import { Router } from 'express';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { authGuard } from '@/common/middlewares/auth.middleware';
import { validateDto } from '@/common/middlewares/validation.middleware';
import { bindRoute } from '@/common/openapi/route-binder';
import { PreRegistrationDto } from './dto/pre-registration.dto';
import { LogoutDto } from './dto/logout.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import {
  RequestDeleteAccountDto,
  VerificationDeleteAccountDto,
} from './dto/delete-account.dto';

export function accountRoutes(): Router {
  const router = Router();
  const ctrl = new AccountController(new AccountService());

  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/account/preRegistration',
    handlerKey: 'preRegistration',
    middlewares: [validateDto(PreRegistrationDto)],
  });
  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/account/logout',
    handlerKey: 'logout',
    middlewares: [authGuard, validateDto(LogoutDto)],
  });
  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/account/changePassword',
    handlerKey: 'changePassword',
    middlewares: [authGuard, validateDto(ChangePasswordDto)],
  });
  bindRoute({
    router,
    controller: ctrl,
    method: 'get',
    path: '/account/getPaymentToken',
    handlerKey: 'getPaymentToken',
    middlewares: [authGuard],
  });
  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/account/requestDeleteAccount',
    handlerKey: 'requestDeleteAccount',
    middlewares: [authGuard, validateDto(RequestDeleteAccountDto)],
  });
  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/account/verificationDeleteAccount',
    handlerKey: 'verificationDeleteAccount',
    middlewares: [authGuard, validateDto(VerificationDeleteAccountDto)],
  });
  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/account/recoverAccountScheduled',
    handlerKey: 'recoverAccountScheduled',
    middlewares: [authGuard],
  });

  return router;
}
