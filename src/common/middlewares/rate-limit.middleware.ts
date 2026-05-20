import rateLimit from 'express-rate-limit';
import type { RequestHandler } from 'express';
import { fail } from '@/common/utils/response.util';
import { env } from '@/config/env';

// Brute-force / abuse throttling for unauthenticated, credential-facing
// endpoints (oauth token, register, forgot-password, OTP, admin login).
// All limiters are keyed by client IP and emit the repo's standard error
// envelope (`{ success:false, error:{ code, message } }`) on 429.

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
 * Strict limiter for credential-facing auth endpoints: password-grant token,
 * register, and forgot-password. ~10 requests / 15 min per IP.
 */
export const authRateLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: tooManyRequestsHandler,
  skip: skipInTest,
});

/**
 * Stricter limiter for OTP-validation endpoints, where a low guess budget is
 * the whole point. ~5 requests / 15 min per IP.
 */
export const otpRateLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: tooManyRequestsHandler,
  skip: skipInTest,
});

/**
 * Limiter for the admin login POST route. ~10 requests / 15 min per IP.
 */
export const adminLoginRateLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: tooManyRequestsHandler,
  skip: skipInTest,
});
