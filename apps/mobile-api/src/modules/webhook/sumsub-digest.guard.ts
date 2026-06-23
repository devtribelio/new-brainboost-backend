import type { RequestHandler } from 'express';
import { verifySumsubWebhookDigest } from '@bb/common/services/sumsub-signature';
import { UnauthorizedException } from '@bb/common/exceptions';

/**
 * Sumsub webhook auth: HMAC digest over the RAW body (captured by the
 * express.json verify hook in app.ts), compared against x-payload-digest.
 * Unlike the Xendit guard (static X-Callback-Token), the digest changes per
 * payload. Fails closed when SUMSUB_WEBHOOK_SECRET is unset.
 */
export const sumsubDigestGuard: RequestHandler = (req, _res, next) => {
  const rawBody = (req as typeof req & { rawBody?: Buffer }).rawBody;
  const digest = req.header('x-payload-digest');
  const alg = req.header('x-payload-digest-alg');
  if (!verifySumsubWebhookDigest(rawBody, digest, alg)) {
    return next(new UnauthorizedException('Invalid webhook digest'));
  }
  next();
};
