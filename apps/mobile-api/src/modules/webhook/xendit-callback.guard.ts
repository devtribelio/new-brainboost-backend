import type { RequestHandler } from 'express';
import { verifyXenditCallbackToken } from '@bb/common/services/xendit-signature';
import { unauthorized, ERROR_CODES } from '@bb/common/exceptions';

export const xenditCallbackGuard: RequestHandler = (req, _res, next) => {
  const headerVal = req.header('x-callback-token') ?? req.header('X-Callback-Token');
  if (!verifyXenditCallbackToken(headerVal)) {
    return next(unauthorized(ERROR_CODES.WEBHOOK_TOKEN_INVALID));
  }
  next();
};
