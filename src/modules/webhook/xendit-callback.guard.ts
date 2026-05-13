import type { RequestHandler } from 'express';
import { xenditService } from '@/common/services/xendit.service';
import { UnauthorizedException } from '@/common/exceptions';

export const xenditCallbackGuard: RequestHandler = (req, _res, next) => {
  const headerVal = req.header('x-callback-token') ?? req.header('X-Callback-Token');
  if (!xenditService.verifyCallbackToken(headerVal)) {
    return next(new UnauthorizedException('Invalid callback token'));
  }
  next();
};
