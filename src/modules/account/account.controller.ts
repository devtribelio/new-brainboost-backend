import type { Request, Response } from 'express';
import { AccountService } from './account.service';
import { notImplemented } from '@/common/utils/response.util';

export class AccountController {
  constructor(private readonly _accountService: AccountService) {}

  preRegistration = async (_req: Request, res: Response) =>
    notImplemented(res, 'account.preRegistration');
  logout = async (_req: Request, res: Response) => notImplemented(res, 'account.logout');
  changePassword = async (_req: Request, res: Response) =>
    notImplemented(res, 'account.changePassword');
  getPaymentToken = async (_req: Request, res: Response) =>
    notImplemented(res, 'account.getPaymentToken');
  requestDeleteAccount = async (_req: Request, res: Response) =>
    notImplemented(res, 'account.requestDeleteAccount');
  verificationDeleteAccount = async (_req: Request, res: Response) =>
    notImplemented(res, 'account.verificationDeleteAccount');
  recoverAccountScheduled = async (_req: Request, res: Response) =>
    notImplemented(res, 'account.recoverAccountScheduled');
}
