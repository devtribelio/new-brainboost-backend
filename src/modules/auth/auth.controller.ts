import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';
import { ok, notImplemented } from '@/common/utils/response.util';

export class AuthController {
  constructor(private readonly authService: AuthService) {}

  login = async (req: Request, res: Response) => {
    const tokens = await this.authService.login(req.body as LoginDto);
    return ok(res, tokens);
  };

  register = async (req: Request, res: Response) => {
    const tokens = await this.authService.register(req.body as RegisterDto);
    return ok(res, tokens, undefined, 201);
  };

  registerDevice = async (_req: Request, res: Response) => notImplemented(res, 'auth.registerDevice');
  cloudMessaging = async (_req: Request, res: Response) => notImplemented(res, 'auth.cloudMessaging');
  requestForgotPassword = async (_req: Request, res: Response) =>
    notImplemented(res, 'auth.requestForgotPassword');
  forgotPasswordVerification = async (_req: Request, res: Response) =>
    notImplemented(res, 'auth.forgotPasswordVerification');
  validateOtp = async (_req: Request, res: Response) => notImplemented(res, 'auth.validateOtp');
}
