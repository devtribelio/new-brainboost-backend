import rateLimit from 'express-rate-limit';
import type { Request, RequestHandler } from 'express';
import { fail } from '@bb/common/utils/response.util';
import { env } from '@bb/common/config/env';

// Real client IP for rate-limit keying.
//
// The deployed chain is Cloudflare -> nginx (proxy_pass 127.0.0.1) -> Node, i.e.
// TWO proxy hops, but the app runs with TRUST_PROXY=1 (trusts nginx only). Express
// therefore resolves `req.ip` to the ROTATING Cloudflare edge IP, not the visitor,
// so per-IP buckets scatter across CF's edge fleet and the limiter never fills
// (verified: 60 login attempts, zero 429s). Cloudflare always sets CF-Connecting-IP
// to the real client and strips any client-supplied copy, so it is the reliable key
// regardless of hop count. Fall back to req.ip for non-CF traffic (dev, LAN, health).
//
// SECURITY NOTE: CF-Connecting-IP is only trustworthy while traffic is forced
// through Cloudflare. The origin (nginx on 0.0.0.0:80/443) MUST be firewalled to
// Cloudflare's published IP ranges, otherwise an attacker reaching the origin
// directly can forge this header. See docs/security-audit-followups.md.
export function clientIp(req: Pick<Request, 'headers' | 'ip'>): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim() !== '') return cf.trim();
  if (Array.isArray(cf) && cf[0]) return cf[0].trim();
  return req.ip ?? 'anonymous';
}

// Brute-force / abuse throttling for unauthenticated, credential-facing
// endpoints (oauth token, register, forgot-password, OTP, admin login).
//
// Each export below is its OWN rateLimit() instance, so each endpoint gets an
// independent per-IP bucket and can be tuned separately — spending the budget
// on one endpoint does not lock the others. All limiters are keyed by client
// IP and emit the repo's standard error envelope
// (`{ success:false, error:{ code, message } }`) on 429.

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

const TOO_MANY_REQUESTS_MESSAGE =
  'Too many requests — please wait a few minutes and try again.';

// Shared 429 responder so every limiter speaks the same envelope as the rest
// of the API (see error.middleware.ts `statusToCode` -> TOO_MANY_REQUESTS).
const tooManyRequestsHandler: RequestHandler = (_req, res) => {
  fail(res, 429, 'TOO_MANY_REQUESTS', TOO_MANY_REQUESTS_MESSAGE);
};

// Disable throttling under the test runner: integration tests hammer these
// endpoints from a single IP and would otherwise trip the limiter (429).
const skipInTest = (): boolean => env.isTest;

/**
 * Build a per-IP rate limiter. Each call returns a fresh instance with its
 * own in-memory store, so distinct endpoints count independently even though
 * they share this module.
 *
 * @param limit    max requests per IP per window
 * @param windowMs rolling window length (default 15 min)
 */
function makeRateLimiter(limit: number, windowMs: number = WINDOW_MS): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: clientIp,
    handler: tooManyRequestsHandler,
    skip: skipInTest,
  });
}

// --- OTP-guess endpoints — lowest budget; code-guessing is the attack -------
export const validateOtpRateLimiter: RequestHandler = makeRateLimiter(3);
export const validateOtpPhoneRateLimiter: RequestHandler = makeRateLimiter(3);
export const validateOtpEmailRateLimiter: RequestHandler = makeRateLimiter(3);
export const forgotPasswordVerifyRateLimiter: RequestHandler = makeRateLimiter(3);

// --- OTP/email SEND endpoints — medium budget; abuse = spamming a victim ----
export const forgotPasswordRequestRateLimiter: RequestHandler = makeRateLimiter(10);
export const requestVerificationPhoneRateLimiter: RequestHandler = makeRateLimiter(10);
export const requestVerificationEmailRateLimiter: RequestHandler = makeRateLimiter(10);

// --- Account creation -------------------------------------------------------
export const registerRateLimiter: RequestHandler = makeRateLimiter(15);
export const registerByPhoneRateLimiter: RequestHandler = makeRateLimiter(15);

// --- Login — looser; legit users mistype passwords -------------------------
export const loginRateLimiter: RequestHandler = makeRateLimiter(30);
export const adminLoginRateLimiter: RequestHandler = makeRateLimiter(10);

// --- Voucher validation — per-member (or per-IP fallback). The dry-run lookup
//     returns a distinct reason per failure mode, i.e. a code-validity oracle.
//     Throttle to stop authenticated voucher-code enumeration.
export const voucherValidateRateLimiter: RequestHandler = rateLimit({
  windowMs: WINDOW_MS,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const user = (req as unknown as { user?: { id?: string } }).user;
    return user?.id ?? clientIp(req);
  },
  handler: tooManyRequestsHandler,
  skip: skipInTest,
});

// --- Media download — per-member (or per-IP fallback). Anti-scrape budget on
//     the signed-download endpoint; streaming is not throttled because legit
//     playback hits the endpoint once per session.
export const mediaDownloadRateLimiter: RequestHandler = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const user = (req as unknown as { user?: { id?: string } }).user;
    return user?.id ?? clientIp(req);
  },
  handler: tooManyRequestsHandler,
  skip: skipInTest,
});
