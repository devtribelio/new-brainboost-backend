import { prisma } from '@bb/db';
import { logger } from './logger';
import { env } from './env';

/** Shape of Prisma's `query` event (mirrored locally — @bb/db exports no types). */
interface PrismaQueryEvent {
  query: string;
  params: string;
  duration: number;
  target: string;
}

interface PrismaMessageEvent {
  message: string;
  target: string;
}

interface MiddlewareParams {
  model?: string;
  action: string;
}

// `prisma` is typed as a bare PrismaClient by @bb/db, which loses the generic
// that types `$on` per configured log level. Narrow it here instead of leaking
// the log config into that package's public type.
type EventfulClient = {
  $on(event: 'query', cb: (e: PrismaQueryEvent) => void): void;
  $on(event: 'info', cb: (e: PrismaMessageEvent) => void): void;
  $use(
    fn: (
      params: MiddlewareParams,
      next: (p: MiddlewareParams) => Promise<unknown>,
    ) => Promise<unknown>,
  ): void;
};

let attached = false;

/**
 * Pipe Prisma's activity into pino, so DB work joins the request trail
 * "request masuk → route → service → DB → response".
 *
 * Two tiers, both off at the default `info` level:
 *   LOG_LEVEL=debug → `db.op`    one line per Prisma call: model, operation,
 *                                durationMs, AND the request context. Emitted
 *                                from `$use`, which runs inside the CALLER's
 *                                async context — that is what makes `requestId`
 *                                available.
 *   LOG_LEVEL=trace → `db.query` the raw SQL + engine timing, from Prisma's
 *                                event stream. NOT correlated: the engine emits
 *                                these from its own async context, so the
 *                                AsyncLocalStorage request context is gone by
 *                                then. Use it to read the SQL, use `db.op` to
 *                                attribute it.
 *
 * Call once per process from the entrypoint (safe to call twice — no-op).
 *
 * NOTE: query PARAMS are never logged. They routinely contain emails, phone
 * numbers, password hashes and OTP codes, and unlike a structured field they
 * cannot be covered by pino's redact config.
 */
export function attachPrismaLogging(): void {
  if (attached || !env.log.prisma) return;
  attached = true;

  const client = prisma as unknown as EventfulClient | undefined;
  // Defensive: query logging is a diagnostic, never a reason to fail boot. The
  // `prisma` binding can come back undefined under some CJS/ESM interop paths
  // (see the export note in @bb/db) — degrade to no query logs instead.
  if (typeof client?.$on !== 'function' || typeof client.$use !== 'function') {
    logger.warn('[prisma-logging] prisma client exposes no $on/$use — db logging disabled');
    return;
  }

  // `$use` is deprecated in favour of `$extends`, but `$extends` returns a NEW
  // client whose type differs from PrismaClient — adopting it means changing
  // what @bb/db exports and re-typing every consumer. Revisit on the Prisma 6
  // upgrade; until then this is one line and behaves identically.
  client.$use(async (params, next) => {
    if (!logger.isLevelEnabled('debug')) return next(params);
    const startedAt = performance.now();
    try {
      return await next(params);
    } finally {
      logger.debug(
        {
          model: params.model,
          operation: params.action,
          durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
        },
        'db.op',
      );
    }
  });

  client.$on('query', (e) => {
    logger.trace({ durationMs: e.duration, query: e.query, target: e.target }, 'db.query');
  });

  client.$on('info', (e) => {
    logger.info({ target: e.target }, e.message);
  });
}
