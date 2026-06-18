/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
/**
 * One-shot data migration: network_member rows for the TWO BrainBoost networks
 * only — Timeline (legacy 23410) and Education (legacy 25136).
 *
 * The global `network-members` phase in migrate-from-legacy.ts is not scoped
 * (it joins every tribelio network). This scopes to the 2 BrainBoost networks
 * and, unlike the global phase, recomputes `Network.countMember` afterwards so
 * the mobile community list shows correct member counts.
 *
 * Order: run AFTER create-bb-networks.ts and AFTER members are migrated.
 * Idempotent: createMany + skipDuplicates (legacyId unique + @@unique[networkId,
 * memberId]); countMember is recomputed from the table, so re-runs converge.
 *
 *   pnpm tsx scripts/migrate-network-members.ts
 */
import 'dotenv/config';
import type { RowDataPacket } from 'mysql2/promise';
import { PrismaClient } from '@prisma/client';
import { connectLegacyDb } from './legacy-db';

const NETWORK_LEGACY_IDS = [23410, 25136]; // BBTIMELN, BBEDUCAT
const BATCH = 5000;

const prisma = new PrismaClient({ log: ['warn', 'error'] });

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function date(value: any): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

async function buildMap(model: { findMany: (a: any) => Promise<any[]> }): Promise<Map<number, string>> {
  const rows = await model.findMany({
    where: { legacyId: { not: null } },
    select: { id: true, legacyId: true },
  });
  return new Map(rows.map((r) => [r.legacyId as number, r.id as string]));
}

async function main() {
  const nets = await prisma.network.findMany({
    where: { legacyId: { in: NETWORK_LEGACY_IDS } },
    select: { id: true, legacyId: true, code: true },
  });
  const networkMap = new Map<number, string>(nets.map((n) => [n.legacyId as number, n.id]));
  const missing = NETWORK_LEGACY_IDS.filter((id) => !networkMap.has(id));
  if (missing.length) {
    throw new Error(
      `Networks not found for legacyId(s) ${missing.join(', ')}. Run create-bb-networks.ts first.`,
    );
  }
  log(`networks: ${nets.map((n) => `${n.code}=${n.legacyId}`).join(', ')}`);

  log('building member map');
  const memberMap = await buildMap(prisma.member);
  log(`members=${memberMap.size}`);

  const legacy = await connectLegacyDb();
  let inserted = 0;
  let skipped = 0;
  try {
    const [rows] = await legacy.query<RowDataPacket[]>(
      `SELECT network_member_id, network_id, member_id, join_date
         FROM network_member
        WHERE status=1 AND network_id IN (?)
        ORDER BY network_member_id`,
      [NETWORK_LEGACY_IDS],
    );
    log(`network-members: legacy rows = ${rows.length}`);

    const all = (rows as any[])
      .map((r) => {
        const networkId = networkMap.get(r.network_id);
        const memberId = memberMap.get(r.member_id);
        if (!networkId || !memberId) {
          skipped++;
          return null;
        }
        return {
          legacyId: r.network_member_id as number,
          networkId,
          memberId,
          joinedAt: date(r.join_date) ?? new Date(),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    for (let i = 0; i < all.length; i += BATCH) {
      const res = await prisma.networkMember.createMany({
        data: all.slice(i, i + BATCH),
        skipDuplicates: true,
      });
      inserted += res.count;
    }
    log(`network-members: inserted=${inserted} skipped=${skipped}`);
  } finally {
    await legacy.end();
  }

  // Recompute countMember from the table (global phase never did this).
  for (const n of nets) {
    const count = await prisma.networkMember.count({ where: { networkId: n.id } });
    await prisma.network.update({ where: { id: n.id }, data: { countMember: count } });
    log(`${n.code}: countMember = ${count}`);
  }

  await prisma.$disconnect();
  log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
