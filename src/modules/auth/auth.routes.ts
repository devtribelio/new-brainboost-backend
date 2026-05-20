import { Router } from 'express';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { validateDto } from '@/common/middlewares/validation.middleware';
import { authGuard } from '@/common/middlewares/auth.middleware';
import { authRateLimiter, otpRateLimiter } from '@/common/middlewares/rate-limit.middleware';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { CloudMessagingDto, RegisterDeviceDto } from './dto/device.dto';
import {
  ForgotPasswordVerificationDto,
  RequestForgotPasswordDto,
  ValidateOtpDto,
} from './dto/forgot-password.dto';
import { RegisterByPhoneDto } from './dto/register-by-phone.dto';
import { RequestVerificationPhoneDto } from './dto/request-verification-phone.dto';
import { ValidateOtpPhoneDto } from './dto/validate-otp-phone.dto';
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
    middlewares: [authRateLimiter, validateDto(LoginDto)],
  });
  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/auth/register',
    handlerKey: 'register',
    middlewares: [authRateLimiter, validateDto(RegisterDto)],
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
    middlewares: [authRateLimiter, validateDto(RequestForgotPasswordDto)],
  });
  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/auth/forgotPasswordVerification',
    handlerKey: 'forgotPasswordVerification',
    middlewares: [authRateLimiter, validateDto(ForgotPasswordVerificationDto)],
  });
  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/auth/validateOtp',
    handlerKey: 'validateOtp',
    middlewares: [otpRateLimiter, validateDto(ValidateOtpDto)],
  });

  // Phone-register flow (T1.1-T1.3, audit #2/#3/#4).
  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/auth/registerByPhone',
    handlerKey: 'registerByPhone',
    middlewares: [authRateLimiter, validateDto(RegisterByPhoneDto)],
  });
  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/auth/requestVerificationPhone',
    handlerKey: 'requestVerificationPhone',
    middlewares: [authRateLimiter, validateDto(RequestVerificationPhoneDto)],
  });
  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/auth/validateOtpPhone',
    handlerKey: 'validateOtpPhone',
    middlewares: [otpRateLimiter, validateDto(ValidateOtpPhoneDto)],
  });

  return router;
}
