import { PrismaClient } from '@prisma/client';
import { env } from './env';

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma =
  global.__prisma ??
  new PrismaClient({
    log: env.isProduction ? ['error', 'warn'] : ['query', 'info', 'warn', 'error'],
  });

if (!env.isProduction) {
  global.__prisma = prisma;
}
