import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { CloudMessagingDto, DeviceEnrollmentResultDto, RegisterDeviceDto } from './dto/device.dto';
import {
  ForgotPasswordVerificationDto,
  RequestForgotPasswordDto,
  ValidateOtpDto,
} from './dto/forgot-password.dto';
import { ok } from '@/common/utils/response.util';
import type { AuthenticatedRequest } from '@/common/interfaces/authenticated-request';
import { UnauthorizedException } from '@/common/exceptions';
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
    description: [
      'Issue tokens. Supported grants:',
      '- `password`: body `{grant_type, username, password}` → access + refresh.',
      '- `refresh_token`: body `{grant_type, refresh_token}` → new access + refresh.',
      '  Old refresh_token is revoked atomically; reuse returns 401 (force re-login).',
      '- `client_credentials`: body `{grant_type, client_id, client_secret}` → access only,',
      '  scope=`anon`. For pre-login flows (splash banner, version check). Disabled when',
      '  `OAUTH_CLIENT_ID`/`OAUTH_CLIENT_SECRET` env vars are unset.',
      '- `social`: not yet implemented.',
    ].join('\n'),
  })
  @ApiBody({ type: () => LoginDto })
  @ApiResponse({ status: 200, description: 'Tokens issued', type: () => TokenBundleDto })
  @ApiResponse({ status: 400, description: 'Invalid request', type: () => ApiErrorResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid credentials', type: () => ApiErrorResponseDto })
  login = async (req: Request, res: Response) => {
    const tokens = await this.authService.login(req.body as LoginDto);
    return res.status(200).json(tokens);
  };

  @ApiOperation({ summary: 'Register a new member' })
  @ApiBody({ type: () => RegisterDto })
  @ApiResponse({ status: 201, description: 'Registered', type: () => TokenBundleDto })
  @ApiResponse({ status: 400, description: 'Validation error', type: () => ApiErrorResponseDto })
  register = async (req: Request, res: Response) => {
    const tokens = await this.authService.register(req.body as RegisterDto);
    return ok(res, tokens, 201);
  };

  @ApiOperation({
    summary: 'Register a device for push notifications',
    description: [
      'Enroll-or-update upsert keyed on `(memberId, deviceId)`. Idempotent.',
      'Use this on app start (and whenever `fcmToken` is first acquired).',
      'For pure FCM token rotation on an already-enrolled device,',
      '`POST /auth/cloudMessaging` is a cheaper update-only path.',
    ].join(' '),
  })
  @ApiBody({ type: () => RegisterDeviceDto })
  @ApiResponse({ status: 200, type: () => DeviceEnrollmentResultDto })
  registerDevice = async (req: Request, res: Response) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) throw new UnauthorizedException('Authentication required');
    const result = await this.authService.registerDevice(user.id, req.body as RegisterDeviceDto);
    return ok(res, result);
  };

  @ApiOperation({
    summary: 'Update FCM token for a device (rotation only)',
    description: [
      'Update-only path: requires the device to be already enrolled via `/auth/devices`.',
      'Returns 404 if no matching device row exists.',
      'Use this for FCM token rotation when re-running enrollment side effects is undesirable.',
      'For first-time enrollment, call `/auth/devices` instead — that endpoint also accepts `fcmToken`.',
    ].join(' '),
  })
  @ApiBody({ type: () => CloudMessagingDto })
  @ApiResponse({ status: 200, type: () => DeviceEnrollmentResultDto })
  cloudMessaging = async (req: Request, res: Response) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) throw new UnauthorizedException('Authentication required');
    const result = await this.authService.registerCloudMessaging(user.id, req.body as CloudMessagingDto);
    return ok(res, result);
  };

  @ApiOperation({ summary: 'Request a forgot-password OTP' })
  @ApiBody({ type: () => RequestForgotPasswordDto })
  @ApiResponse({ status: 200, type: () => GenericOkDto })
  requestForgotPassword = async (req: Request, res: Response) => {
    const result = await this.authService.requestForgotPassword(req.body as RequestForgotPasswordDto);
    return ok(res, result);
  };

  @ApiOperation({ summary: 'Verify OTP + set new password' })
  @ApiBody({ type: () => ForgotPasswordVerificationDto })
  @ApiResponse({ status: 200, type: () => GenericOkDto })
  forgotPasswordVerification = async (req: Request, res: Response) => {
    const result = await this.authService.forgotPasswordVerification(
      req.body as ForgotPasswordVerificationDto,
    );
    return ok(res, result);
  };

  @ApiOperation({ summary: 'Validate a generic OTP (registration / phone verify / etc.)' })
  @ApiBody({ type: () => ValidateOtpDto })
  @ApiResponse({ status: 200, type: () => GenericOkDto })
  validateOtp = async (req: Request, res: Response) => {
    const result = await this.authService.validateOtp(req.body as ValidateOtpDto);
    return ok(res, result);
  };
}
