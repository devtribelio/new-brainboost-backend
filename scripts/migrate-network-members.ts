/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
/**
 * One-shot data migration: every migrated member belongs to BOTH BrainBoost networks —
 * Timeline (legacy 23410) and Education (legacy 25136).
 *
 * BrainBoost has exactly these two community networks and EVERY member is a member of
 * both — it is mandatory, not derived from legacy membership. So instead of importing only
 * the legacy `network_member` rows, we create a NetworkMember for every Member × both
 * networks. Where a legacy `network_member` row exists we preserve its `legacyId` +
 * `join_date`; otherwise `legacyId = null` and `joinedAt = member.createdAt`.
 *
 * Order: run AFTER create-bb-networks.ts and AFTER members are migrated.
 * Idempotent: createMany + skipDuplicates (@@unique[networkId, memberId]); countMember is
 * recomputed from the table, so re-runs converge.
 *
 *   pnpm tsx scripts/migrate-network-members.ts
 */
import 'dotenv/config';
import type { RowDataPacket } from 'mysql2/promise';
import { PrismaClient } from '@prisma/client';
import { connectLegacyDb } from './legacy-db';

const NETWORK_LEGACY_IDS = [23410, 25136]; // BB-TIMELINE (23410), BB-EDUCATION (25136)
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

  log('loading members');
  const members = await prisma.member.findMany({
    where: { legacyId: { not: null } },
    select: { id: true, legacyId: true, createdAt: true },
  });
  log(`members=${members.length}`);

  // Preserve legacy membership metadata (legacyId + join_date) where it exists:
  //   key = `${legacyNetworkId}:${legacyMemberId}` -> { legacyId, joinedAt }
  const legacy = await connectLegacyDb();
  const legacyJoin = new Map<string, { legacyId: number; joinedAt: Date | undefined }>();
  try {
    const [rows] = await legacy.query<RowDataPacket[]>(
      `SELECT network_member_id, network_id, member_id, join_date
         FROM network_member
        WHERE status=1 AND network_id IN (?)`,
      [NETWORK_LEGACY_IDS],
    );
    for (const r of rows as any[]) {
      legacyJoin.set(`${r.network_id}:${r.member_id}`, {
        legacyId: Number(r.network_member_id),
        joinedAt: date(r.join_date),
      });
    }
    log(`legacy network_member rows (metadata): ${legacyJoin.size}`);
  } finally {
    await legacy.end();
  }

  // Every member belongs to BOTH networks. Build member × network rows.
  const data: { legacyId: number | null; networkId: string; memberId: string; joinedAt: Date }[] = [];
  for (const m of members) {
    for (const legacyNetId of NETWORK_LEGACY_IDS) {
      const networkId = networkMap.get(legacyNetId)!;
      const meta = legacyJoin.get(`${legacyNetId}:${m.legacyId}`);
      data.push({
        legacyId: meta?.legacyId ?? null,
        networkId,
        memberId: m.id,
        joinedAt: meta?.joinedAt ?? m.createdAt ?? new Date(),
      });
    }
  }

  let inserted = 0;
  for (let i = 0; i < data.length; i += BATCH) {
    const res = await prisma.networkMember.createMany({
      data: data.slice(i, i + BATCH),
      skipDuplicates: true,
    });
    inserted += res.count;
  }
  log(`network-members: candidates=${data.length} inserted=${inserted}`);

  // Recompute countMember from the table.
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
