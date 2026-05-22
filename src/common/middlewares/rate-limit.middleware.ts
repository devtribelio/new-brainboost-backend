import rateLimit from 'express-rate-limit';
import type { RequestHandler } from 'express';
import { fail } from '@/common/utils/response.util';
import { env } from '@/config/env';

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
    handler: tooManyRequestsHandler,
    skip: skipInTest,
  });
}

// --- OTP-guess endpoints — lowest budget; code-guessing is the attack -------
export const validateOtpRateLimiter = makeRateLimiter(3);
export const validateOtpPhoneRateLimiter = makeRateLimiter(3);
export const forgotPasswordVerifyRateLimiter = makeRateLimiter(3);

// --- OTP/email SEND endpoints — medium budget; abuse = spamming a victim ----
export const forgotPasswordRequestRateLimiter = makeRateLimiter(10);
export const requestVerificationPhoneRateLimiter = makeRateLimiter(10);

// --- Account creation -------------------------------------------------------
export const registerRateLimiter = makeRateLimiter(15);
export const registerByPhoneRateLimiter = makeRateLimiter(15);

// --- Login — looser; legit users mistype passwords -------------------------
export const loginRateLimiter = makeRateLimiter(30);
export const adminLoginRateLimiter = makeRateLimiter(10);
