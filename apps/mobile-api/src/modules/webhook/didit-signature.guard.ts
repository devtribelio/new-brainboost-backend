import type { RequestHandler } from 'express';
import { verifyDiditWebhookSignature } from '@bb/common/services/didit-signature';
import { UnauthorizedException } from '@bb/common/exceptions';

/**
 * Didit webhook auth: HMAC-SHA256 over the RAW body (captured by the express.json
 * verify hook in app.ts), compared against the X-Signature header, plus a replay
 * guard on X-Timestamp (±300s). Fails closed when DIDIT_WEBHOOK_SECRET is unset.
 */
export const diditSignatureGuard: RequestHandler = (req, _res, next) => {
  const rawBody = (req as typeof req & { rawBody?: Buffer }).rawBody;
  const signature = req.header('x-signature');
  const timestamp = req.header('x-timestamp');
  if (!verifyDiditWebhookSignature(rawBody, signature, timestamp)) {
    return next(new UnauthorizedException('Invalid webhook signature'));
  }
  next();
};
