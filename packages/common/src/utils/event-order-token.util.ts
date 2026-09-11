import crypto from 'node:crypto';
import { env } from '@bb/common/config/env';

/**
 * Opaque order token, carried as `?t=` on the redirect an event invoice sends the
 * buyer to after paying.
 *
 * `GET /api/event/order/:code` authenticates on the payer's email, which the
 * Xendit redirect cannot carry: Xendit actively encourages opening checkout on a
 * desktop and paying by QR on a phone, and that buyer lands with no stash to read
 * the email back out of. The order code alone is no substitute — it is
 * `BB-YYYYMMDD-####` with a per-day counter (see `generateOrderCode`), so it is
 * enumerable, and the page lists every attendee's name and email.
 *
 * Format: `base64url(code).base64url(exp).base64url(hmac)` — signed, NOT
 * encrypted. The media token next door seals with AES-GCM because the Bunny
 * `guid` inside it must stay secret; here the code is already in the URL path, so
 * there is nothing to hide and HMAC is the smaller tool.
 *
 * The key is DERIVED from `env.jwt.accessSecret` rather than configured — no new
 * env var, no Secrets Manager entry, and nothing to add at deploy time. What it is
 * NOT is the access secret itself: `verifyAccessToken` casts its payload without
 * checking its shape, so signing with that secret directly would mint a token the
 * auth path also trusts. The `LABEL` below is the domain separation that prevents
 * it — this key cannot sign a JWT, and leaking it does not reveal its parent.
 *
 * It was considered for `app_settings` (rotatable over SQL, like the order URL
 * beside it) and rejected: those rows travel in every database dump, and this key
 * forges a token for ANY order code — which, with codes being an enumerable
 * per-day counter, reads out every attendee's name and email.
 *
 * Consequence to know: rotating `JWT_ACCESS_SECRET` also invalidates order tokens
 * in flight, for at most the 24h below. That rotation already logs every member
 * out, so it is not a new kind of disruption.
 */

/**
 * 24h. It must outlive the whole payment window (30 min by default, see
 * `event.checkoutExpiryMinutes`) plus the buyer landing and polling, because the
 * token is minted when the invoice is created and an in-flight redirect cannot
 * have its URL swapped. The page is read-only, so a long life costs little.
 */
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

/**
 * Domain separator. Bump the version if the token format ever changes: every
 * token signed under the old label stops verifying, which is the point.
 */
const LABEL = 'event-order-token|v1';

/** Key derived per call — `env` is read lazily so tests can swap the secret. */
function key(): Buffer {
  return crypto.createHash('sha256').update(`${LABEL}|${env.jwt.accessSecret}`).digest();
}

function sign(code: string, exp: number): string {
  return crypto.createHmac('sha256', key()).update(`${code}|${exp}`).digest('base64url');
}

/** Mint a token for one order code. */
export function signEventOrderToken(code: string, ttlSeconds = DEFAULT_TTL_SECONDS): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const parts = [Buffer.from(code, 'utf8').toString('base64url'), String(exp)];
  return `${parts.join('.')}.${sign(code, exp)}`;
}

/**
 * Verify a token and return the order code it was minted for.
 *
 * Returns `null` — never throws — for anything malformed, tampered or expired.
 * That is not laziness: the endpoint answers the SAME 404 for an unknown code, a
 * wrong email and a bad token, because a 401 would confirm to a guesser that the
 * code exists. A throwing verifier would have leaked exactly that distinction.
 */
export function verifyEventOrderToken(token: string): { code: string } | null {
  const parts = (token ?? '').split('.');
  if (parts.length !== 3) return null;

  const [rawCode, rawExp, mac] = parts;
  const exp = Number(rawExp);
  if (!Number.isSafeInteger(exp) || exp * 1000 < Date.now()) return null;

  let code: string;
  try {
    code = Buffer.from(rawCode, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!code) return null;

  const expected = Buffer.from(sign(code, exp), 'utf8');
  const given = Buffer.from(mac ?? '', 'utf8');
  // timingSafeEqual throws on a length mismatch, which is itself public
  // information here (the digest length is fixed), so check it first.
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;

  return { code };
}
