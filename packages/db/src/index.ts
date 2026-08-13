import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

const isProduction = process.env.NODE_ENV === 'production';

// `query`/`info` are EMITTED AS EVENTS rather than written to stdout, so they can
// be piped through pino and inherit the request context (requestId/route/userId)
// like every other log line — subscribe with `attachPrismaLogging()` from
// @bb/common/config/prisma-logging. With no subscriber the events are dropped,
// which is what we want in tests and one-off scripts (they used to spam raw
// query output).
//
// `error`/`warn` deliberately stay on stdout: many entrypoints (scripts/, the
// workers) never call attachPrismaLogging, and an unsubscribed event would mean
// silently losing DB errors. Their request-level context is already captured by
// errorHandler.
//
// This package stays dependency-free (no @bb/common import) on purpose.
export const prisma =
  global.__prisma ??
  new PrismaClient({
    log: [
      { level: 'error', emit: 'stdout' },
      { level: 'warn', emit: 'stdout' },
      ...(isProduction
        ? []
        : ([
            { level: 'query', emit: 'event' },
            { level: 'info', emit: 'event' },
          ] as const)),
    ],
  });

if (!isProduction) {
  global.__prisma = prisma;
}

// NOTE: do not `export * from '@prisma/client'` here — re-exporting a CJS
// module's star alongside `export const prisma` makes esbuild/tsx clobber the
// named `prisma` export at runtime (becomes undefined). Consumers import types
// from '@prisma/client' directly.
