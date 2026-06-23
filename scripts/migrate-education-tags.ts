/* eslint-disable no-console */
/**
 * One-shot data migration: legacy `post_tag` rows -> new Postgres `network_tags`.
 *
 * Scope: legacy `post_tag` WHERE network_id = 25136.
 * Distinct `tag` values become NetworkTag rows on the local network `BB-EDUCATION`.
 * NetworkTag has no legacyId; idempotency relies on @@unique([networkId, name]).
 * Safe to re-run.
 *
 *   pnpm tsx scripts/migrate-education-tags.ts
 */
import 'dotenv/config';
import type { RowDataPacket } from 'mysql2/promise';
import { PrismaClient } from '@prisma/client';
import { connectLegacyDb } from './legacy-db';

const LEGACY_NETWORK_ID = 25136;
const TARGET_NETWORK_CODE = 'BB-EDUCATION';

const prisma = new PrismaClient({ log: ['warn', 'error'] });

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

async function main() {
  const network = await prisma.network.findFirst({
    where: { code: TARGET_NETWORK_CODE },
    select: { id: true, name: true },
  });
  if (!network) {
    throw new Error(`Local network with code "${TARGET_NETWORK_CODE}" not found.`);
  }
  log(`target network: ${network.name} (${network.id})`);

  const legacy = await connectLegacyDb();
  const [rows] = await legacy.query<RowDataPacket[]>(
    `SELECT tag FROM post_tag WHERE network_id = ? ORDER BY post_tag_id`,
    [LEGACY_NETWORK_ID],
  );
  await legacy.end();
  log(`legacy post_tag rows: ${rows.length}`);

  // Distinct, trimmed, non-empty tag names (one post_tag row per post — names repeat).
  const names = [
    ...new Set(
      rows
        .map((r) => (r.tag == null ? '' : String(r.tag).trim()))
        .filter((t) => t !== ''),
    ),
  ];
  log(`distinct tags: ${names.length}`);

  const existing = new Set(
    (
      await prisma.networkTag.findMany({
        where: { networkId: network.id, name: { in: names } },
        select: { name: true },
      })
    ).map((t) => t.name),
  );

  const data = names
    .filter((name) => !existing.has(name))
    .map((name) => ({ networkId: network.id, name }));

  let created = 0;
  if (data.length) {
    const res = await prisma.networkTag.createMany({ data, skipDuplicates: true });
    created = res.count;
  }

  log(`network_tags: ${created} created, ${existing.size} already present`);
  log(`tags: ${names.join(', ')}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
