import type { Request, Response } from 'express';
import { AccountService } from './account.service';
import { notImplemented } from '@/common/utils/response.util';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@/common/openapi/decorators';

@ApiTags('Account')
export class AccountController {
  constructor(private readonly _accountService: AccountService) {}

  @ApiOperation({ summary: 'Pre-registration (request OTP for signup)' })
  @ApiResponse({ status: 200 })
  preRegistration = async (_req: Request, res: Response) =>
    notImplemented(res, 'account.preRegistration');

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Logout (revoke refresh token)' })
  @ApiResponse({ status: 200 })
  logout = async (_req: Request, res: Response) => notImplemented(res, 'account.logout');

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change password' })
  @ApiResponse({ status: 200 })
  changePassword = async (_req: Request, res: Response) =>
    notImplemented(res, 'account.changePassword');

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get payment provider token' })
  @ApiResponse({ status: 200 })
  getPaymentToken = async (_req: Request, res: Response) =>
    notImplemented(res, 'account.getPaymentToken');

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Request account deletion (soft, scheduled)' })
  @ApiResponse({ status: 200 })
  requestDeleteAccount = async (_req: Request, res: Response) =>
    notImplemented(res, 'account.requestDeleteAccount');

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Verify OTP and finalize account deletion' })
  @ApiResponse({ status: 200 })
  verificationDeleteAccount = async (_req: Request, res: Response) =>
    notImplemented(res, 'account.verificationDeleteAccount');

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Recover an account scheduled for deletion' })
  @ApiResponse({ status: 200 })
  recoverAccountScheduled = async (_req: Request, res: Response) =>
    notImplemented(res, 'account.recoverAccountScheduled');
}
