/* eslint-disable no-console */
/**
 * Manually clear the resync run-lock. Use when a run was hard-killed (SIGKILL / host
 * teardown) before its finally-block released the lock, and you don't want to wait out
 * the TTL (RESYNC_LOCK_TTL_SEC, default 2× interval). Safe: the lock is advisory.
 *
 *   pnpm resync:unlock
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({ log: ['warn', 'error'] });

async function main() {
  const lock = await prisma.syncState.findUnique({ where: { syncer: '__lock__' } });
  if (!lock || lock.lastRunAt === null) {
    console.log('[resync:unlock] no lock held — nothing to do');
    return;
  }
  console.log(`[resync:unlock] clearing lock held since ${lock.lastRunAt.toISOString()} (${JSON.stringify(lock.lastStats)})`);
  await prisma.syncState.update({ where: { syncer: '__lock__' }, data: { lastRunAt: null } });
  console.log('[resync:unlock] DONE');
}

main()
  .catch((err) => {
    console.error('[resync:unlock] fatal', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
