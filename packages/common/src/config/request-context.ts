import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Per-request ambient context, propagated through the async call chain by
 * AsyncLocalStorage.
 *
 * Why this exists: the service layer (`@bb/domain`) already logs plenty of
 * useful lines, but none of them can be tied back to the HTTP request that
 * triggered them. Threading a logger through every constructor would touch
 * every module; instead the request logger opens a context here and
 * `config/logger.ts` mixes it into EVERY log line automatically. Services keep
 * calling the plain `logger` and still come out correlated.
 *
 * Nothing outside the HTTP path has a context — `getRequestContext()` simply
 * returns undefined in workers/cron/tests and the mixin adds no fields.
 */
export interface RequestContext {
  /** Correlation id. Echoed to the client as `X-Request-Id`. */
  requestId: string;
  method: string;
  /** Path as requested (query string stripped). */
  path: string;
  /**
   * Matched Express route pattern (e.g. `/api/member/:id`). Only known once the
   * router has resolved, so it is filled in at response time.
   */
  route?: string;
  /** `Controller.method` that served the request, filled in by `bindRoute`. */
  handler?: string;
  /** Set by the auth guards once the bearer token is verified. */
  userId?: string;
  /** Error code emitted by `errorHandler`, so the response line carries it. */
  errorCode?: string;
  /**
   * Scrubbed snapshot of the query string, taken ON ARRIVAL. Must be captured
   * early: `validateDto(Dto, 'query')` REPLACES `req.query` with a transformed,
   * whitelisted DTO instance, so reading it at response time reports coerced
   * types and silently omits params the DTO does not declare.
   */
  query?: unknown;
  ip?: string;
  /** `performance.now()`-style start marker used to compute durationMs. */
  startedAt: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** Run `fn` (and everything it awaits) inside a fresh request context. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Merge fields into the ACTIVE context. No-op outside a request, so callers
 * never need to guard (a worker calling a service that enriches context is
 * fine).
 */
export function setRequestContext(patch: Partial<Omit<RequestContext, 'requestId'>>): void {
  const ctx = storage.getStore();
  if (!ctx) return;
  Object.assign(ctx, patch);
}

// Inbound ids come from clients/proxies, and they land in log files — so they
// are treated as untrusted input: conservative charset, hard length cap. A
// value that fails the check is replaced rather than sanitised, because a
// half-stripped id is worse than a fresh one (it silently breaks correlation
// with the caller's own logs either way).
const SAFE_ID_RE = /^[A-Za-z0-9._:-]{8,64}$/;

export function resolveRequestId(inbound: unknown): string {
  const raw = Array.isArray(inbound) ? inbound[0] : inbound;
  if (typeof raw === 'string' && SAFE_ID_RE.test(raw)) return raw;
  return randomUUID();
}
