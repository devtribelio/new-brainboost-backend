/* eslint-disable no-console */
/**
 * One-shot: alias every legacy dedup loser's affiliate code to its winner.
 * See code-aliases.ts. Idempotent; takes the resync run-lock.
 *
 *   pnpm resync:code-aliases [--dry-run]
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { syncCodeAliases } from './code-aliases';
import { resyncConfig } from './config';
import { acquireLock, releaseLock } from './core';
import { connectResilientLegacy } from './legacy-db';

const log = (msg: string) => console.log(`[code-aliases] ${msg}`);

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const prisma = new PrismaClient({ log: ['warn', 'error'] });
  const lock = await acquireLock(prisma);
  if (!lock) {
    console.error('another resync run holds the lock — try again later (or pnpm resync:unlock if it is stale)');
    await prisma.$disconnect();
    process.exitCode = 1;
    return;
  }
  const legacy = await connectResilientLegacy({ dateStrings: false }, resyncConfig.legacyReconnectRetries, log);
  try {
    await syncCodeAliases({ prisma, legacy, dryRun, log });
  } finally {
    await releaseLock(prisma, lock);
    await legacy.end();
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[code-aliases] fatal', err);
  process.exit(1);
});
