import { Router } from 'express';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { validateDto } from '@/common/middlewares/validation.middleware';
import { authGuard } from '@/common/middlewares/auth.middleware';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { CloudMessagingDto, RegisterDeviceDto } from './dto/device.dto';
import {
  ForgotPasswordVerificationDto,
  RequestForgotPasswordDto,
  ValidateOtpDto,
} from './dto/forgot-password.dto';
import { bindRoute } from '@/common/openapi/route-binder';

export function authRoutes(): Router {
  const router = Router();
  const ctrl = new AuthController(new AuthService());

  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/oauth/token',
    handlerKey: 'login',
    middlewares: [validateDto(LoginDto)],
  });
  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/auth/register',
    handlerKey: 'register',
    middlewares: [validateDto(RegisterDto)],
  });
  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/auth/devices',
    handlerKey: 'registerDevice',
    middlewares: [authGuard, validateDto(RegisterDeviceDto)],
  });
  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/auth/cloudMessaging',
    handlerKey: 'cloudMessaging',
    middlewares: [authGuard, validateDto(CloudMessagingDto)],
  });
  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/auth/requestForgotPassword',
    handlerKey: 'requestForgotPassword',
    middlewares: [validateDto(RequestForgotPasswordDto)],
  });
  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/auth/forgotPasswordVerification',
    handlerKey: 'forgotPasswordVerification',
    middlewares: [validateDto(ForgotPasswordVerificationDto)],
  });
  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/auth/validateOtp',
    handlerKey: 'validateOtp',
    middlewares: [validateDto(ValidateOtpDto)],
  });

  return router;
}
