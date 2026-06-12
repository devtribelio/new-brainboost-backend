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
import {
  PhoneVerificationResponseDto,
  RegisterByPhoneDto,
} from './dto/register-by-phone.dto';
import { RequestVerificationPhoneDto } from './dto/request-verification-phone.dto';
import { ValidateOtpPhoneDto } from './dto/validate-otp-phone.dto';
import {
  EmailVerificationResponseDto,
  RequestVerificationEmailDto,
} from './dto/request-verification-email.dto';
import { ValidateOtpEmailDto } from './dto/validate-otp-email.dto';
import { RequestVerifyDto, VerifyDto } from './dto/verify-contact.dto';
import { ok, okCreated } from '@bb/common/utils/response.util';
import type { AuthenticatedRequest } from '@bb/common/interfaces/authenticated-request';
import { UnauthorizedException } from '@bb/common/exceptions';
import {
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@bb/common/openapi/decorators';
import { ErrorEnvelopeDto, GenericOkDto, TokenBundleDto } from '@bb/common/openapi/common.dto';

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
  @ApiResponse({ status: 400, description: 'Invalid request', type: () => ErrorEnvelopeDto, envelope: 'none' })
  @ApiResponse({ status: 401, description: 'Invalid credentials', type: () => ErrorEnvelopeDto, envelope: 'none' })
  login = async (req: Request, res: Response) => {
    const tokens = await this.authService.login(req.body as LoginDto);
    return ok(res, tokens);
  };

  @ApiOperation({
    summary: 'Register a new member (email flow)',
    description: [
      'Creates an INACTIVE member (`isActive=false`, `isEmailVerified=false`) and sends a',
      '`verify-email` OTP. No tokens are issued — follow up with `/auth/validateOtpEmail`',
      'to activate, then log in via `/oauth/token`. Re-registering with an email/phone that',
      'belongs to an abandoned unverified register reuses that row instead of erroring.',
    ].join(' '),
  })
  @ApiBody({ type: () => RegisterDto })
  @ApiResponse({ status: 201, description: 'Registered, OTP sent', type: () => EmailVerificationResponseDto })
  @ApiResponse({ status: 400, description: 'Validation error', type: () => ErrorEnvelopeDto, envelope: 'none' })
  register = async (req: Request, res: Response) => {
    const result = await this.authService.register(req.body as RegisterDto);
    return okCreated(res, result);
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

  @ApiOperation({
    summary: 'Register a new member by phone (FE legacy phone-register flow)',
    description: [
      'Creates an unverified member from `{phone, phoneCode, name, password}`.',
      'Email column is filled with a synthetic placeholder (`phone-<code>-<num>@phone.brainboost.local`)',
      'until the user sets a real email. Issues a `verify-phone` OTP — caller must follow up',
      'with `/auth/validateOtpPhone` to mark `isPhoneVerified=true`.',
    ].join(' '),
  })
  @ApiBody({ type: () => RegisterByPhoneDto })
  @ApiResponse({ status: 200, type: () => PhoneVerificationResponseDto })
  @ApiResponse({ status: 400, type: () => ErrorEnvelopeDto, envelope: 'none' })
  registerByPhone = async (req: Request, res: Response) => {
    const result = await this.authService.registerByPhone(req.body as RegisterByPhoneDto);
    return ok(res, result);
  };

  @ApiOperation({
    summary: 'Re-issue phone verification OTP (resend on FE register step)',
  })
  @ApiBody({ type: () => RequestVerificationPhoneDto })
  @ApiResponse({ status: 200, type: () => PhoneVerificationResponseDto })
  requestVerificationPhone = async (req: Request, res: Response) => {
    const result = await this.authService.requestVerificationPhone(
      req.body as RequestVerificationPhoneDto,
    );
    return ok(res, result);
  };

  @ApiOperation({
    summary: 'Validate phone OTP — marks isPhoneVerified=true and activates the member',
  })
  @ApiBody({ type: () => ValidateOtpPhoneDto })
  @ApiResponse({ status: 200, type: () => GenericOkDto })
  validateOtpPhone = async (req: Request, res: Response) => {
    const result = await this.authService.validateOtpPhone(req.body as ValidateOtpPhoneDto);
    return ok(res, result);
  };

  @ApiOperation({
    summary: 'Re-issue email verification OTP (pre-login, by memberId)',
    description: [
      'Resend the `verify-email` OTP for an unverified member from the email-register flow.',
      'No auth — the member cannot log in yet. Mirror of `/auth/requestVerificationPhone`.',
    ].join(' '),
  })
  @ApiBody({ type: () => RequestVerificationEmailDto })
  @ApiResponse({ status: 200, type: () => EmailVerificationResponseDto })
  requestVerificationEmail = async (req: Request, res: Response) => {
    const result = await this.authService.requestVerificationEmail(
      req.body as RequestVerificationEmailDto,
    );
    return ok(res, result);
  };

  @ApiOperation({
    summary: 'Validate email OTP — marks isEmailVerified=true and activates the member',
    description:
      'Pre-login counterpart of `/auth/verifyEmail`. Mirror of `/auth/validateOtpPhone`.',
  })
  @ApiBody({ type: () => ValidateOtpEmailDto })
  @ApiResponse({ status: 200, type: () => GenericOkDto })
  validateOtpEmail = async (req: Request, res: Response) => {
    const result = await this.authService.validateOtpEmail(req.body as ValidateOtpEmailDto);
    return ok(res, result);
  };

  @ApiOperation({
    summary: 'Request contact verification OTP (email or phone)',
    description:
      "Send a 6-digit OTP to the authenticated member's email (SES) or phone (WhatsApp), " +
      'per `type`. Replaces `/auth/requestVerifyEmail`.',
  })
  @ApiBody({ type: () => RequestVerifyDto })
  @ApiResponse({ status: 200, type: () => GenericOkDto })
  requestVerify = async (req: Request, res: Response) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) throw new UnauthorizedException('Authentication required');
    const result = await this.authService.requestVerify(
      user.id,
      (req.body as RequestVerifyDto).type,
    );
    return ok(res, result);
  };

  @ApiOperation({
    summary: 'Submit contact verification OTP — sets isEmailVerified / isPhoneVerified',
    description: 'Replaces `/auth/verifyEmail`.',
  })
  @ApiBody({ type: () => VerifyDto })
  @ApiResponse({ status: 200, type: () => GenericOkDto })
  verify = async (req: Request, res: Response) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) throw new UnauthorizedException('Authentication required');
    const body = req.body as VerifyDto;
    const result = await this.authService.verify(user.id, body.type, body.code);
    return ok(res, result);
  };
}
