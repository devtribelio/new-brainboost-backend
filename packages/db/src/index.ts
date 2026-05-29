import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

const isProduction = process.env.NODE_ENV === 'production';

export const prisma =
  global.__prisma ??
  new PrismaClient({
    log: isProduction ? ['error', 'warn'] : ['query', 'info', 'warn', 'error'],
  });

if (!isProduction) {
  global.__prisma = prisma;
}

// NOTE: do not `export * from '@prisma/client'` here — re-exporting a CJS
// module's star alongside `export const prisma` makes esbuild/tsx clobber the
// named `prisma` export at runtime (becomes undefined). Consumers import types
// from '@prisma/client' directly.
