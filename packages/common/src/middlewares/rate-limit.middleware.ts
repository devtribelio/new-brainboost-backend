import { createHash } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import type { Request, RequestHandler } from 'express';
import type { IncrementResponse, Options, Store } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { Redis } from 'ioredis';
import { fail } from '@bb/common/utils/response.util';
import { env } from '@bb/common/config/env';
import { logger } from '@bb/common/config/logger';
import { otpPhoneTarget } from '@bb/common/utils/phone.util';

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
// endpoints (oauth token, register, forgot-password, OTP).
//
// Each export below is its OWN rateLimit() instance, so each endpoint gets an
// independent bucket and can be tuned separately — spending the budget on one
// endpoint does not lock the others. Limiters are keyed on the ACCOUNT
// IDENTIFIER carried in the request body (username / email / phone / memberId),
// NOT the client IP — a whole office or mobile carrier shares one NAT'd IP, so
// IP keying would make them lock each other out (see `byIdentifier`). IP is only
// a fallback when the body has no usable identifier. All emit the repo's
// standard error envelope (`{ success:false, error:{ code, message } }`) on 429.

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

// --- Shared store (multi-instance deployments) ------------------------------
// The default store is an in-memory MemoryStore, one per Node process. On a
// multi-instance deployment (ECS with 2-6 Fargate tasks) each task keeps its
// own counter, so the effective limit becomes `limit x taskCount` and resets on
// every deploy — the limiter is defeated even with correct keying. When
// REDIS_URL is set, every limiter is backed by Redis so all instances share one
// counter. REDIS_URL unset (local dev, single-process PM2 staging) => default
// MemoryStore, behaviour unchanged. Each limiter passes a distinct `name` used
// as the Redis key prefix so buckets stay independent (MemoryStore got this for
// free by being a fresh instance per rateLimit() call).

let redisClient: Redis | undefined;
function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = new Redis(env.redisUrl, {
      // Rate limiting must never take the API down. Bound retries so a dead
      // Redis rejects fast (-> FailOpenStore lets the request through) instead
      // of hanging the request.
      maxRetriesPerRequest: 2,
      connectTimeout: 3000,
    });
    // ioredis emits 'error' on each failed (re)connect; swallow + log so an
    // unhandled 'error' event can never crash the process.
    redisClient.on('error', (err) => logger.error({ err }, 'rate-limit redis client error'));
  }
  return redisClient;
}

/**
 * Connectivity probe for the rate-limit Redis, for startup checks / the
 * connection monitor. Returns 'skipped' when REDIS_URL is unset (in-memory
 * MemoryStore — nothing to check), 'ok' when a PING succeeds, throws otherwise.
 * Reuses the exact client the limiters use, so a success also warms the pool.
 *
 * NON-fatal by contract: callers must NOT exit the process on failure. The store
 * fails open, so a missing Redis degrades to per-process limiting — it must
 * never take the API down (that would be worse than the runtime behaviour).
 */
export async function checkRedisConnection(): Promise<'ok' | 'skipped'> {
  if (!env.redisUrl) return 'skipped';
  await getRedisClient().ping();
  return 'ok';
}

// Fail-OPEN wrapper: if Redis is unreachable, allow the request rather than
// 500 the endpoint. A limiter outage should degrade to "no throttling", never
// to "auth is down". The only cost of an outage is a window of unthrottled
// traffic; correct counting resumes automatically once Redis is back.
export class FailOpenStore implements Store {
  constructor(private readonly inner: Store) {}
  init(options: Options): void {
    this.inner.init?.(options);
  }
  async increment(key: string): Promise<IncrementResponse> {
    try {
      return await this.inner.increment(key);
    } catch (err) {
      logger.error({ err }, 'rate-limit store increment failed — failing open');
      return { totalHits: 0, resetTime: undefined };
    }
  }
  async decrement(key: string): Promise<void> {
    try {
      await this.inner.decrement(key);
    } catch (err) {
      logger.error({ err }, 'rate-limit store decrement failed');
    }
  }
  async resetKey(key: string): Promise<void> {
    try {
      await this.inner.resetKey(key);
    } catch (err) {
      logger.error({ err }, 'rate-limit store resetKey failed');
    }
  }
}

// A Redis-backed store when REDIS_URL is set, wrapped so a Redis outage fails
// open. Returns `{}` (no `store` key) otherwise, so express-rate-limit keeps its
// default per-process MemoryStore. Spreading `{}` avoids overriding that default
// with an explicit `undefined`.
function storeOption(name: string): { store?: Store } {
  if (!env.redisUrl) return {};
  const inner = new RedisStore({
    prefix: `rl:${name}:`,
    // ioredis transport: rate-limit-redis runs the atomic increment via Lua; we
    // only forward the raw command.
    sendCommand: (...args: string[]) =>
      getRedisClient().call(...(args as [string, ...string[]])) as Promise<RedisReply>,
  });
  return { store: new FailOpenStore(inner) };
}

// --- Per-identifier keying (shared-IP / carrier-NAT safe) -------------------
// Credential endpoints behind a single office/carrier NAT share ONE public IP,
// so keying on IP makes colleagues (or thousands of mobile users on one carrier)
// share a bucket and lock each other out — the tight 3-attempt OTP limiters
// especially. Instead key on the account identifier in the request body. IP is
// used ONLY when the body has no usable identifier (malformed request, or a
// social/refresh login grant that carries no username). Per-identifier is also
// STRICTER against a targeted attack: an OTP-guess budget is per victim, not per
// attacker-IP, so rotating IPs can't multiply the number of guesses.
//
// The identifier is normalized (casing/formatting can't spawn a fresh bucket)
// and hashed (raw emails/phones never land in Redis keys).

type BodyIdentifier = (body: Record<string, unknown>) => string | undefined;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

// keyGenerator that keys on a body-derived identifier, falling back to the
// client IP when absent. `kind` namespaces identifier types so e.g. an email and
// a memberId with the same text can never collide.
function byIdentifier(kind: string, extract: BodyIdentifier): (req: Request) => string {
  return (req) => {
    const id = extract((req.body ?? {}) as Record<string, unknown>);
    if (!id) return `ip:${clientIp(req)}`;
    const hash = createHash('sha256').update(`${kind}:${id}`).digest('base64url').slice(0, 24);
    return `${kind}:${hash}`;
  };
}

const byUsername = byIdentifier('username', (b) => str(b.username)?.toLowerCase());
const byMemberId = byIdentifier('member', (b) => str(b.memberId));
const byTarget = byIdentifier('target', (b) => str(b.target)?.toLowerCase());
// Phone register: canonical '+628111…' (same target the OTP service builds).
const byPhoneTarget = byIdentifier('phone', (b) => {
  const phone = str(b.phone);
  const code = str(b.phoneCode);
  return phone && code ? otpPhoneTarget(code, phone) : undefined;
});
// Register: the username (email/handle) or, failing that, the phone target.
const byRegisterTarget = byIdentifier('register', (b) => {
  const username = str(b.username)?.toLowerCase();
  if (username) return username;
  const phone = str(b.phone);
  const code = str(b.phoneCode);
  return phone && code ? otpPhoneTarget(code, phone) : undefined;
});
// Forgot-password: email, or a digits-normalized phone (no phoneCode field here).
const byEmailOrPhone = byIdentifier('reset', (b) => {
  const email = str(b.email)?.toLowerCase();
  if (email) return email;
  const phone = str(b.phone);
  return phone ? phone.replace(/[^0-9]/g, '') || undefined : undefined;
});

/** Internal: identifier keyers exposed for unit tests. Not part of the public API. */
export const _keyers = {
  byUsername,
  byMemberId,
  byTarget,
  byPhoneTarget,
  byRegisterTarget,
  byEmailOrPhone,
};

/**
 * Build a rate limiter. Keyed by `opts.keyGenerator` (default: client IP);
 * credential limiters pass a per-identifier keyer so shared NAT'd clients don't
 * collide. `name` namespaces the bucket (Redis key prefix) so distinct endpoints
 * count independently even when two share the same identifier keyer.
 *
 * @param name                   unique bucket id (also the Redis key prefix)
 * @param limit                  max requests per key per window
 * @param windowMs               rolling window length (default 15 min)
 * @param keyGenerator           how to derive the bucket key (default clientIp)
 * @param skipSuccessfulRequests only count failures (login: don't punish success)
 */
function makeRateLimiter(opts: {
  name: string;
  limit: number;
  windowMs?: number;
  keyGenerator?: (req: Request) => string;
  skipSuccessfulRequests?: boolean;
}): RequestHandler {
  return rateLimit({
    windowMs: opts.windowMs ?? WINDOW_MS,
    limit: opts.limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: opts.keyGenerator ?? clientIp,
    skipSuccessfulRequests: opts.skipSuccessfulRequests ?? false,
    ...storeOption(opts.name),
    handler: tooManyRequestsHandler,
    skip: skipInTest,
  });
}

// --- OTP-guess endpoints — lowest budget; code-guessing is the attack. Keyed
//     on the identifier being verified so 3 guesses is per-victim, not per-IP. --
export const validateOtpRateLimiter: RequestHandler = makeRateLimiter({
  name: 'otp-validate',
  limit: 3,
  keyGenerator: byTarget,
});
export const validateOtpPhoneRateLimiter: RequestHandler = makeRateLimiter({
  name: 'otp-validate-phone',
  limit: 3,
  keyGenerator: byMemberId,
});
export const validateOtpEmailRateLimiter: RequestHandler = makeRateLimiter({
  name: 'otp-validate-email',
  limit: 3,
  keyGenerator: byMemberId,
});
export const forgotPasswordVerifyRateLimiter: RequestHandler = makeRateLimiter({
  name: 'forgot-verify',
  limit: 3,
  keyGenerator: byEmailOrPhone,
});

// --- OTP/email SEND endpoints — medium budget; abuse = spamming a victim.
//     Keyed on the target (memberId / email|phone) being messaged. ------------
export const forgotPasswordRequestRateLimiter: RequestHandler = makeRateLimiter({
  name: 'forgot-request',
  limit: 10,
  keyGenerator: byEmailOrPhone,
});
export const requestVerificationPhoneRateLimiter: RequestHandler = makeRateLimiter({
  name: 'verify-request-phone',
  limit: 10,
  keyGenerator: byMemberId,
});
export const requestVerificationEmailRateLimiter: RequestHandler = makeRateLimiter({
  name: 'verify-request-email',
  limit: 10,
  keyGenerator: byMemberId,
});

// --- Account creation — keyed on the identity being registered --------------
export const registerRateLimiter: RequestHandler = makeRateLimiter({
  name: 'register',
  limit: 15,
  keyGenerator: byRegisterTarget,
});
export const registerByPhoneRateLimiter: RequestHandler = makeRateLimiter({
  name: 'register-phone',
  limit: 15,
  keyGenerator: byPhoneTarget,
});

// --- Login — keyed per-account (username); only FAILED attempts count, so a
//     colleague logging in successfully never spends a shared budget. Social /
//     refresh grants carry no username -> IP fallback (they can't brute-force). --
export const loginRateLimiter: RequestHandler = makeRateLimiter({
  name: 'login',
  limit: 30,
  keyGenerator: byUsername,
  skipSuccessfulRequests: true,
});

// NOTE: the former `adminLoginRateLimiter` was removed with the admin app
// (deleted 2026-07) — it had no consumers. Volumetric per-IP protection for
// these endpoints belongs at the edge (Cloudflare / AWS WAF rate rules with a
// CAPTCHA challenge), NOT an in-app per-IP cap, which would re-introduce the
// carrier-NAT lockout this per-identifier keying exists to prevent.

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
  ...storeOption('voucher-validate'),
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
  ...storeOption('media-download'),
  handler: tooManyRequestsHandler,
  skip: skipInTest,
});
