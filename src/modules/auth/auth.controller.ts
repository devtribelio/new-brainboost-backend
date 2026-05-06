import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { CloudMessagingDto, RegisterDeviceDto } from './dto/device.dto';
import {
  ForgotPasswordVerificationDto,
  RequestForgotPasswordDto,
  ValidateOtpDto,
} from './dto/forgot-password.dto';
import { ok, notImplemented } from '@/common/utils/response.util';
import {
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@/common/openapi/decorators';
import { ApiErrorResponseDto, GenericOkDto, TokenBundleDto } from '@/common/openapi/common.dto';

@ApiTags('Auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @ApiOperation({
    summary: 'OAuth2 token endpoint',
    description: 'Issue access+refresh tokens. Supports `password` and `refresh_token` grants.',
  })
  @ApiBody({ type: () => LoginDto })
  @ApiResponse({ status: 200, description: 'Tokens issued', type: () => TokenBundleDto })
  @ApiResponse({ status: 400, description: 'Invalid request', type: () => ApiErrorResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid credentials', type: () => ApiErrorResponseDto })
  login = async (req: Request, res: Response) => {
    const tokens = await this.authService.login(req.body as LoginDto);
    return ok(res, tokens);
  };

  @ApiOperation({ summary: 'Register a new member' })
  @ApiBody({ type: () => RegisterDto })
  @ApiResponse({ status: 201, description: 'Registered', type: () => TokenBundleDto })
  @ApiResponse({ status: 400, description: 'Validation error', type: () => ApiErrorResponseDto })
  register = async (req: Request, res: Response) => {
    const tokens = await this.authService.register(req.body as RegisterDto);
    return ok(res, tokens, undefined, 201);
  };

  @ApiOperation({ summary: 'Register a device for push notifications' })
  @ApiBody({ type: () => RegisterDeviceDto })
  @ApiResponse({ status: 200, type: () => GenericOkDto })
  registerDevice = async (_req: Request, res: Response) => notImplemented(res, 'auth.registerDevice');

  @ApiOperation({ summary: 'Update FCM token for a device' })
  @ApiBody({ type: () => CloudMessagingDto })
  @ApiResponse({ status: 200, type: () => GenericOkDto })
  cloudMessaging = async (_req: Request, res: Response) => notImplemented(res, 'auth.cloudMessaging');

  @ApiOperation({ summary: 'Request a forgot-password OTP' })
  @ApiBody({ type: () => RequestForgotPasswordDto })
  @ApiResponse({ status: 200, type: () => GenericOkDto })
  requestForgotPassword = async (_req: Request, res: Response) =>
    notImplemented(res, 'auth.requestForgotPassword');

  @ApiOperation({ summary: 'Verify OTP + set new password' })
  @ApiBody({ type: () => ForgotPasswordVerificationDto })
  @ApiResponse({ status: 200, type: () => GenericOkDto })
  forgotPasswordVerification = async (_req: Request, res: Response) =>
    notImplemented(res, 'auth.forgotPasswordVerification');

  @ApiOperation({ summary: 'Validate a generic OTP (registration / phone verify / etc.)' })
  @ApiBody({ type: () => ValidateOtpDto })
  @ApiResponse({ status: 200, type: () => GenericOkDto })
  validateOtp = async (_req: Request, res: Response) => notImplemented(res, 'auth.validateOtp');
}
