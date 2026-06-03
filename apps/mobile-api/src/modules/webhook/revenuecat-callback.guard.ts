import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { env } from '@bb/common/config/env';
import { UnauthorizedException } from '@bb/common/exceptions';

/**
 * Authenticate a RevenueCat webhook via the static `Authorization` header
 * configured in the RC dashboard (shared secret). Fails closed: an unset
 * secret rejects every call. Constant-time compare avoids leaking the secret
 * length/content via timing. Ports the edge function's `verifyBearer`.
 *
 * RC sends the configured value verbatim (it may or may not include a
 * `Bearer ` prefix depending on dashboard config) — we accept both.
 */
export const revenueCatCallbackGuard: RequestHandler = (req, _res, next) => {
  const expected = env.revenuecat.webhookAuth;
  if (!expected) return next(new UnauthorizedException('RevenueCat webhook not configured'));

  const header = req.header('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : header;
  if (!constantTimeEqual(presented, expected)) {
    return next(new UnauthorizedException('Invalid RevenueCat authorization'));
  }
  next();
};

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  try {
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}
