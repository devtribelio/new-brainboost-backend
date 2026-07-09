/* eslint-disable no-console */
/**
 * Reset the stored watermark for the named syncers back to null, so their next run
 * re-drains from the beginning (idempotent — upserts, no duplicates).
 *
 *   pnpm resync:reset-watermark commissions enrollments kyc members reviews tree
 *
 * WHY (one-time): watermarks are `max(COALESCE(updated,created))` of the LEGACY rows —
 * i.e. legacy timestamps, not now(). Watermarks recorded BEFORE the mysql2 `timezone`
 * fix are +7h off (WIB read as UTC). After the fix, legacy dates read 7h earlier, so a
 * stale +7 watermark would skip a ~7h window of changes. Resetting the affected syncers
 * closes that gap safely. Requires explicit syncer names (no accidental mass reset).
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({ log: ['warn', 'error'] });

async function main() {
  const names = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (names.length === 0) {
    console.error('usage: pnpm resync:reset-watermark <syncer> [syncer...]');
    process.exit(1);
  }
  if (names.includes('__lock__')) {
    console.error('refusing to reset the __lock__ row');
    process.exit(1);
  }
  const res = await prisma.syncState.updateMany({
    where: { syncer: { in: names } },
    data: { watermark: null },
  });
  console.log(`[resync:reset-watermark] cleared watermark for ${res.count} syncer(s): ${names.join(', ')}`);
  const rows = await prisma.syncState.findMany({
    where: { syncer: { in: names } },
    select: { syncer: true, watermark: true },
  });
  for (const r of rows) console.log(`  ${r.syncer}: watermark=${r.watermark ?? '(null)'}`);
}

main()
  .catch((err) => {
    console.error('[resync:reset-watermark] fatal', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
