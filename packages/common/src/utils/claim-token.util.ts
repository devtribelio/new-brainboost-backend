import crypto from 'node:crypto';
import { env } from '@bb/common/config/env';

/**
 * Opaque account-claim token, carried as `?token=` on the `/claim` link a
 * post-payment email sends an auto-provisioned buyer.
 *
 * An auto-provisioned buyer (member with `passwordAlgo='social'`,
 * `isEmailVerified=false`, no `googleSub`/`appleSub`) already has access but no
 * usable password, so they cannot log in. This token authorizes exactly one
 * thing — setting that password to "claim" the account — and carries the
 * `memberId` it was minted for so the set-password endpoint needs nothing from
 * the URL but the token.
 *
 * Format and key derivation mirror `event-order-token.util.ts`:
 * `base64url(memberId).base64url(exp).base64url(hmac)` — signed, NOT encrypted.
 * There is nothing secret in the payload (the memberId is not usable on its own;
 * the claim endpoint re-checks the member is still unclaimed), so HMAC is the
 * smaller tool over AES-GCM.
 *
 * The key is DERIVED from `env.jwt.accessSecret` rather than configured — no new
 * env var, no Secrets Manager entry. It is NOT the access secret itself: the
 * `LABEL` below is the domain separation, so this key cannot sign a JWT the auth
 * path trusts, and leaking it does not reveal its parent. A distinct label from
 * the event-order token means neither token can ever verify as the other.
 *
 * Consequence to know: rotating `JWT_ACCESS_SECRET` also invalidates claim tokens
 * in flight, for at most the TTL below. That rotation already logs every member
 * out, so it is not a new kind of disruption.
 */

/**
 * 7 days. The claim email may sit unread for a while, and the link is the buyer's
 * only path to a usable password, so it must outlive a normal "I'll do it later".
 * The endpoint is single-use in effect (once claimed, `passwordAlgo !== 'social'`
 * and the token is refused), so a long life costs little.
 */
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Domain separator. Bump the version if the token format ever changes: every
 * token signed under the old label stops verifying, which is the point.
 */
const LABEL = 'claim-account.v1';

/** Key derived per call — `env` is read lazily so tests can swap the secret. */
function key(): Buffer {
  return crypto.createHash('sha256').update(`${LABEL}|${env.jwt.accessSecret}`).digest();
}

function sign(memberId: string, exp: number): string {
  return crypto.createHmac('sha256', key()).update(`${memberId}|${exp}`).digest('base64url');
}

/** Mint a claim token for one member. */
export function signClaimToken(memberId: string, ttlSeconds = DEFAULT_TTL_SECONDS): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const parts = [Buffer.from(memberId, 'utf8').toString('base64url'), String(exp)];
  return `${parts.join('.')}.${sign(memberId, exp)}`;
}

/**
 * Verify a claim token and return the member id it was minted for.
 *
 * Returns `null` — never throws — for anything malformed, tampered or expired.
 * The claim endpoints turn a `null` here into a single generic "invalid or
 * expired" response, so a bad token is indistinguishable from a stale one and
 * the token cannot be probed.
 */
export function verifyClaimToken(token: string): { memberId: string } | null {
  const parts = (token ?? '').split('.');
  if (parts.length !== 3) return null;

  const [rawMemberId, rawExp, mac] = parts;
  const exp = Number(rawExp);
  if (!Number.isSafeInteger(exp) || exp * 1000 < Date.now()) return null;

  let memberId: string;
  try {
    memberId = Buffer.from(rawMemberId, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!memberId) return null;

  const expected = Buffer.from(sign(memberId, exp), 'utf8');
  const given = Buffer.from(mac ?? '', 'utf8');
  // timingSafeEqual throws on a length mismatch, which is itself public
  // information here (the digest length is fixed), so check it first.
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;

  return { memberId };
}
