import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '@bb/common/config/env';

/**
 * Sign a Sumsub API request (X-App-Access-Sig header).
 * HMAC-SHA256 over `ts + METHOD + path(+query) + body`, hex-encoded.
 * Docs: https://docs.sumsub.com/reference/authentication
 */
export function signSumsubRequest(
  secretKey: string,
  ts: number,
  method: string,
  pathWithQuery: string,
  body?: string,
): string {
  return createHmac('sha256', secretKey)
    .update(`${ts}${method.toUpperCase()}${pathWithQuery}${body ?? ''}`)
    .digest('hex');
}

/** Algorithms Sumsub announces via the x-payload-digest-alg webhook header. */
const DIGEST_ALGS: Record<string, string> = {
  HMAC_SHA1_HEX: 'sha1',
  HMAC_SHA256_HEX: 'sha256',
  HMAC_SHA512_HEX: 'sha512',
};

/**
 * Verify a Sumsub webhook: HMAC over the RAW request body bytes, compared
 * against the x-payload-digest header. Fails closed when the secret is unset.
 */
export function verifySumsubWebhookDigest(
  rawBody: Buffer | undefined,
  digestHeader: string | undefined,
  algHeader: string | undefined,
): boolean {
  const secret = env.sumsub.webhookSecret;
  if (!secret || !rawBody || !digestHeader) return false;
  const alg = DIGEST_ALGS[algHeader ?? 'HMAC_SHA256_HEX'];
  if (!alg) return false;
  const expected = createHmac(alg, secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(digestHeader);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
