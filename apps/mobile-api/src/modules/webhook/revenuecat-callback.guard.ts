import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { env } from '@bb/common/config/env';
import { UnauthorizedException } from '@bb/common/exceptions';
import { credentialService } from '@/modules/ingest/credential.service';

/**
 * Authenticate a RevenueCat webhook via the static `Authorization` header
 * configured in the RC dashboard (shared secret). Fails closed.
 *
 * Source of truth is the DB: the secret is stored as the `revenuecat`
 * `ThirdPartyCredential`'s key (hash only). Rotating it on a leak is a single
 * `pnpm issue:credential revenuecat --refund` (DB upsert) — NO redeploy.
 *
 * `env.revenuecat.webhookAuth` is an OPTIONAL bootstrap/emergency fallback: if
 * the DB row is missing/broken and the env secret is set, a matching header
 * still passes (constant-time). Leave it unset in steady state to make the DB
 * the only authority.
 *
 * RC sends the configured value verbatim (with or without a `Bearer ` prefix
 * depending on dashboard config) — both accepted.
 */
export const revenueCatCallbackGuard: RequestHandler = async (req, _res, next) => {
  try {
    const header = req.header('authorization') ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : header;
    if (!presented) throw new UnauthorizedException('Missing RevenueCat authorization');

    // Primary: DB-stored, rotatable secret.
    const cred = await credentialService.verifySecret(env.revenuecat.providerName, presented);
    if (cred) return next();

    // Fallback: env secret (bootstrap / emergency only).
    const envSecret = env.revenuecat.webhookAuth;
    if (envSecret && constantTimeEqual(presented, envSecret)) return next();

    throw new UnauthorizedException('Invalid RevenueCat authorization');
  } catch (err) {
    next(err);
  }
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
