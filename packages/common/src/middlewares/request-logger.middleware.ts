import type { Request, RequestHandler, Response } from 'express';
import { logger } from '@bb/common/config/logger';
import { env } from '@bb/common/config/env';
import { clientIp } from '@bb/common/utils/client-ip.util';
import { scrubDeep } from '@bb/common/config/log-redaction';
import {
  getRequestContext,
  resolveRequestId,
  runWithRequestContext,
  setRequestContext,
  type RequestContext,
} from '@bb/common/config/request-context';

export const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * Access logger + request-context opener. Mount it FIRST, before helmet/cors/
 * body parsing, so that:
 *   - a body-parse failure or a 429 still produces a log line, and
 *   - every downstream log (middleware, controller, `@bb/domain` service, Prisma)
 *     carries the same `requestId` via the pino mixin.
 *
 * Emits one structured line per request when it completes:
 *   `http.response`  — normal completion (any status)
 *   `http.aborted`   — socket closed before the response finished (client gone,
 *                      timeout, crash mid-stream). These are invisible to
 *                      morgan-style loggers and are exactly what you want when
 *                      chasing "the app hangs" reports.
 * Plus an optional `http.request` line on arrival (LOG_HTTP_INCOMING=true).
 *
 * Replaces morgan: same information, but JSON (queryable in CloudWatch/Loki),
 * with the correlation id, the matched route pattern, the authenticated user and
 * the error code the request ended with.
 */
export const requestLogger: RequestHandler = (req, res, next) => {
  const requestId = resolveRequestId(req.headers['x-request-id']);
  const ctx: RequestContext = {
    requestId,
    method: req.method,
    path: stripQuery(req.originalUrl || req.url),
    ip: clientIp(req),
    startedAt: performance.now(),
    query: snapshotQuery(req),
  };

  // Echo the id back so a client (or the mobile app's crash reporter) can quote
  // it in a bug report and we can pull the whole request out of the logs.
  res.setHeader(REQUEST_ID_HEADER, requestId);

  runWithRequestContext(ctx, () => {
    // The context is opened even for ignored paths — a /health handler that logs
    // should still be correlated; only the access lines are suppressed.
    if (!env.log.http || isIgnored(ctx.path)) return next();

    if (env.log.httpIncoming) {
      logger.info(
        {
          method: ctx.method,
          path: ctx.path,
          ip: ctx.ip,
          userAgent: userAgent(req),
          ...(ctx.query !== undefined ? { query: ctx.query } : {}),
          // No body here, and not by choice: this runs as the FIRST middleware,
          // before express.json() has read the body off the socket — for a
          // streamed request the bytes may not even have arrived yet. The body
          // appears on the response line (from the raw bytes, see describeBody).
        },
        'http.request',
      );
    }

    // 'finish' = response fully flushed; 'close' also fires on an aborted
    // socket, where 'finish' never does. First one wins, so each request is
    // logged exactly once.
    let logged = false;
    const complete = (aborted: boolean) => {
      if (logged) return;
      logged = true;
      emit(req, res, aborted);
    };
    res.on('finish', () => complete(false));
    res.on('close', () => complete(true));

    next();
  });
};

function emit(req: Request, res: Response, aborted: boolean): void {
  // Read the context back rather than closing over it: the auth guards, the
  // route binder and the error handler all enrich it while the request runs.
  const ctx = getRequestContext();
  if (!ctx) return;

  const durationMs = Math.round((performance.now() - ctx.startedAt) * 10) / 10;
  const status = res.statusCode;
  const slow = durationMs >= env.log.slowRequestMs;

  const payload: Record<string, unknown> = {
    method: ctx.method,
    path: ctx.path,
    ...(ctx.route ? { route: ctx.route } : {}),
    ...(ctx.handler ? { handler: ctx.handler } : {}),
    status,
    durationMs,
    ip: ctx.ip,
    userAgent: userAgent(req),
    ...(ctx.errorCode ? { errorCode: ctx.errorCode } : {}),
    ...(slow ? { slow: true } : {}),
    ...(aborted ? { aborted: true } : {}),
  };

  const length = res.getHeader('content-length');
  if (length !== undefined) payload.contentLength = Number(length);

  // From the context, i.e. the ARRIVAL snapshot — NOT `req.query`, which
  // validateDto(Dto, 'query') has replaced by then (see snapshotQuery).
  if (ctx.query !== undefined) payload.query = ctx.query;

  if (env.log.httpBody) {
    const body = describeBody(req);
    if (body !== undefined) payload.body = body;
  }

  // 5xx is ours to fix, 4xx is the client's — but a burst of either matters, so
  // neither is info. Slow 2xx is a warn too: that is the signal a latency alert
  // should fire on.
  const level = status >= 500 ? 'error' : status >= 400 || slow || aborted ? 'warn' : 'info';
  logger[level](payload, aborted ? 'http.aborted' : 'http.response');
}

/**
 * Scrubbed copy of the query string as the CLIENT sent it, taken while
 * `requestLogger` is the first middleware — i.e. before any DTO can rewrite it.
 *
 * `validateDto(Dto, 'query')` does `req.query = plainToInstance(...)` with
 * `enableImplicitConversion` + `whitelist`, so by response time `req.query` has
 * coerced types (`"2"` → `2`) and has DROPPED every param the DTO does not
 * declare — which is exactly the misspelled-param bug you want the log to show.
 *
 * Returns undefined for a request with no query string, so the key is omitted
 * rather than logged as `{}`.
 */
function snapshotQuery(req: Request): unknown {
  const query = req.query as Record<string, unknown> | undefined;
  if (!query || Object.keys(query).length === 0) return undefined;
  // Query strings carry tokens often enough (?token=…, ?otp=…) that this needs the
  // same deep scrub as the body; pino's redact only reaches one level down.
  return scrubDeep(query);
}

function stripQuery(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

function isIgnored(path: string): boolean {
  return env.log.ignorePaths.some((p) => path === p || path.startsWith(`${p}/`));
}

function userAgent(req: Request): string | undefined {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua.slice(0, 200) : undefined;
}

const BODY_MAX_CHARS = 2000;

/**
 * The request body, made safe to log. Returns undefined when there is nothing
 * worth logging (GET/HEAD, empty body).
 *
 * Order matters: **scrub first, truncate second**. Truncation produces a JSON
 * *string*, and pino's `redact` only walks object keys — so a secret inside an
 * over-cap body would otherwise be printed verbatim. `scrubDeep` also catches
 * nesting that pino's one-level `*.key` paths miss (`user.password`,
 * `items[0].token`).
 */
function describeBody(req: Request): unknown {
  // GET/HEAD/OPTIONS carry no body; express.json leaves `req.body` as `{}`.
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return undefined;

  const contentType = req.headers['content-type'] ?? '';
  // Multipart is handled by multer, which puts the FILE elsewhere and leaves only
  // text fields on req.body. Say so explicitly rather than implying the upload
  // itself was empty.
  const isMultipart = typeof contentType === 'string' && contentType.includes('multipart/');

  const body = rawJsonBody(req) ?? (req.body as unknown);
  if (body === undefined || body === null) return isMultipart ? '[multipart]' : undefined;
  if (Buffer.isBuffer(body)) return `[buffer ${body.length}b]`;
  if (typeof body !== 'object') return body;
  if (Object.keys(body as object).length === 0) return isMultipart ? '[multipart]' : undefined;

  const scrubbed = scrubDeep(body);
  const json = safeStringify(scrubbed);
  if (json === undefined) return '[unserializable]';
  if (json.length <= BODY_MAX_CHARS) return isMultipart ? { fields: scrubbed } : scrubbed;
  // Already scrubbed, so the truncated string carries no secrets.
  return `${json.slice(0, BODY_MAX_CHARS)}…[truncated ${json.length}b]`;
}

/**
 * The body AS THE CLIENT SENT IT, from the raw bytes kept by `express.json`'s
 * verify hook (see app.ts).
 *
 * Why not just `req.body`: `validateDto` replaces `req.body` with the transformed,
 * whitelisted DTO instance, so unknown properties are gone by the time this runs.
 * Logging that version hides the most common client bug there is — a misspelled
 * or renamed field silently dropped — which is precisely what body logging is for.
 *
 * Returns undefined when there are no raw bytes (urlencoded, multipart, no body)
 * so the caller falls back to `req.body`.
 */
function rawJsonBody(req: Request): unknown {
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!raw || raw.length === 0) return undefined;
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    // Malformed JSON (express.json already answered 400). Deliberately NOT logging
    // the raw text: it cannot be scrubbed structurally, and a body with a typo'd
    // brace still contains the password.
    return `[unparseable json body ${raw.length}b]`;
  }
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * Record the resolved route + handler on the active context. Called by
 * `bindRoute` so downstream service logs carry `route`, and by nothing else —
 * the route pattern is only knowable once Express has matched.
 */
export function tagRoute(req: Request, handler: string): void {
  const route = (req as Request & { route?: { path?: string } }).route?.path;
  setRequestContext({
    route: route ? `${req.baseUrl}${route === '/' ? '' : route}` : undefined,
    handler,
  });
}
