/* eslint-disable no-console */
/**
 * One-off: import scripts/member-redirect.json (written by migrate:members) into the
 * durable `member_redirect` table the resync uses. Idempotent (skipDuplicates).
 *
 *   pnpm resync:seed-redirect
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

const PATH = 'scripts/member-redirect.json';
const prisma = new PrismaClient({ log: ['warn', 'error'] });

async function main() {
  const raw = JSON.parse(readFileSync(PATH, 'utf8')) as Record<string, number>;
  const data = Object.entries(raw).map(([loser, winner]) => ({
    loserLegacyId: Number(loser),
    winnerLegacyId: Number(winner),
  }));
  console.log(`[seed-redirect] ${PATH}: ${data.length} entries`);
  let inserted = 0;
  for (let i = 0; i < data.length; i += 1000) {
    const res = await prisma.memberRedirect.createMany({ data: data.slice(i, i + 1000), skipDuplicates: true });
    inserted += res.count;
  }
  console.log(`[seed-redirect] DONE inserted=${inserted} (existing skipped=${data.length - inserted})`);
}

main()
  .catch((err) => {
    console.error('[seed-redirect] fatal', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
