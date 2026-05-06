import { Router } from 'express';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { asyncHandler } from '@/common/utils/async-handler';
import { validateDto } from '@/common/middlewares/validation.middleware';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { CloudMessagingDto, RegisterDeviceDto } from './dto/device.dto';
import {
  ForgotPasswordVerificationDto,
  RequestForgotPasswordDto,
  ValidateOtpDto,
} from './dto/forgot-password.dto';

export function authRoutes(): Router {
  const router = Router();
  const ctrl = new AuthController(new AuthService());

  router.post('/oauth/token', validateDto(LoginDto), asyncHandler(ctrl.login));
  router.post('/auth/register', validateDto(RegisterDto), asyncHandler(ctrl.register));
  router.post('/auth/devices', validateDto(RegisterDeviceDto), asyncHandler(ctrl.registerDevice));
  router.post(
    '/auth/cloudMessaging',
    validateDto(CloudMessagingDto),
    asyncHandler(ctrl.cloudMessaging),
  );
  router.post(
    '/auth/requestForgotPassword',
    validateDto(RequestForgotPasswordDto),
    asyncHandler(ctrl.requestForgotPassword),
  );
  router.post(
    '/auth/forgotPasswordVerification',
    validateDto(ForgotPasswordVerificationDto),
    asyncHandler(ctrl.forgotPasswordVerification),
  );
  router.post('/auth/validateOtp', validateDto(ValidateOtpDto), asyncHandler(ctrl.validateOtp));

  return router;
}
