import type { Request, Response } from 'express';
import { AccountService } from './account.service';
import { ok } from '@bb/common/utils/response.util';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@bb/common/openapi/decorators';
import { ErrorEnvelopeDto, GenericOkDto } from '@bb/common/openapi/common.dto';
import type { AuthenticatedRequest } from '@bb/common/interfaces/authenticated-request';
import { UnauthorizedException } from '@bb/common/exceptions';
import { PreRegistrationDto } from './dto/pre-registration.dto';
import { LogoutDto } from './dto/logout.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import {
  RequestDeleteAccountDto,
  VerificationDeleteAccountDto,
} from './dto/delete-account.dto';
import { GetPaymentTokenQueryDto } from './dto/payment-token.dto';
import { AffiliateConnectResultDto } from './dto/affiliate-connect.dto';

function requireUser(req: Request): AuthenticatedRequest['user'] & { id: string; email: string } {
  const user = (req as AuthenticatedRequest).user;
  if (!user) throw new UnauthorizedException('Authentication required');
  return user;
}

@ApiTags('Account')
export class AccountController {
  constructor(private readonly accountService: AccountService) {}

  @ApiOperation({ summary: 'Pre-registration (request OTP for signup)' })
  @ApiBody({ type: () => PreRegistrationDto })
  @ApiResponse({ status: 200, type: () => GenericOkDto })
  @ApiResponse({ status: 400, type: () => ErrorEnvelopeDto, envelope: 'none' })
  preRegistration = async (req: Request, res: Response) => {
    const result = await this.accountService.preRegistration(req.body as PreRegistrationDto);
    return ok(res, result);
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Connect affiliator code to member (binds inviter, idempotent)' })
  @ApiResponse({ status: 200, type: () => AffiliateConnectResultDto })
  @ApiResponse({ status: 400, type: () => ErrorEnvelopeDto, envelope: 'none' })
  @ApiResponse({ status: 404, type: () => ErrorEnvelopeDto, envelope: 'none' })
  affiliateConnect = async (req: Request, res: Response) => {
    const user = requireUser(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const affiliatorCode = (body.affiliatorCode || body.affiliateCode || body.affCode) as string;
    const result = await this.accountService.affiliateConnect(user.id, affiliatorCode);
    return ok(res, result);
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Logout (revoke refresh token)' })
  @ApiBody({ type: () => LogoutDto })
  @ApiResponse({ status: 200, type: () => GenericOkDto })
  logout = async (req: Request, res: Response) => {
    const user = requireUser(req);
    const result = await this.accountService.logout(user.id, req.body as LogoutDto);
    return ok(res, result);
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change password' })
  @ApiBody({ type: () => ChangePasswordDto })
  @ApiResponse({ status: 200, type: () => GenericOkDto })
  changePassword = async (req: Request, res: Response) => {
    const user = requireUser(req);
    const result = await this.accountService.changePassword(user.id, req.body as ChangePasswordDto);
    return ok(res, result);
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get payment provider token (stub envelope)' })
  @ApiQuery({ name: 'id', required: false })
  @ApiQuery({ name: 'type', required: false })
  @ApiResponse({ status: 200, type: () => GenericOkDto })
  getPaymentToken = async (req: Request, res: Response) => {
    const result = await this.accountService.getPaymentToken(req.query as GetPaymentTokenQueryDto);
    return ok(res, result);
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Request account deletion (15-day grace period)' })
  @ApiBody({ type: () => RequestDeleteAccountDto })
  @ApiResponse({ status: 200, type: () => GenericOkDto })
  requestDeleteAccount = async (req: Request, res: Response) => {
    const user = requireUser(req);
    const result = await this.accountService.requestDeleteAccount(
      user.id,
      req.body as RequestDeleteAccountDto,
    );
    return ok(res, result);
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Verify OTP and finalize account deletion' })
  @ApiBody({ type: () => VerificationDeleteAccountDto })
  @ApiResponse({ status: 200, type: () => GenericOkDto })
  verificationDeleteAccount = async (req: Request, res: Response) => {
    const user = requireUser(req);
    const result = await this.accountService.verificationDeleteAccount(
      user.id,
      req.body as VerificationDeleteAccountDto,
    );
    return ok(res, result);
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Recover an account scheduled for deletion' })
  @ApiResponse({ status: 200, type: () => GenericOkDto })
  recoverAccountScheduled = async (req: Request, res: Response) => {
    const user = requireUser(req);
    const result = await this.accountService.recoverAccountScheduled(user.id);
    return ok(res, result);
  };
}
