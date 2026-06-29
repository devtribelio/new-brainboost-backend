import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '@bb/common/config/env';

/** Reject webhooks whose X-Timestamp is more than this many seconds from now. */
export const DIDIT_TIMESTAMP_TOLERANCE_SEC = 300;

/**
 * Verify a Didit webhook: HMAC-SHA256 over the RAW request body bytes (the
 * `X-Signature` variant), compared against the X-Signature header, plus a replay
 * guard on X-Timestamp (abs(now - ts) <= 300s). Fails closed when the secret is
 * unset, the signature is missing/mismatched, or the timestamp is stale/out of
 * window. Uses the per-destination `secret_shared_key` (env.didit.webhookSecret).
 * Docs: https://docs.didit.me/integration/webhooks
 */
export function verifyDiditWebhookSignature(
  rawBody: Buffer | undefined,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
  nowMs: number = Date.now(),
): boolean {
  const secret = env.didit.webhookSecret;
  if (!secret || !rawBody || !signatureHeader || !timestampHeader) return false;

  // Replay guard: timestamp must be a number within the tolerance window.
  const ts = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - ts) > DIDIT_TIMESTAMP_TOLERANCE_SEC) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
