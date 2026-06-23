/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
/**
 * One-shot data migration: legacy `topic` rows -> new Postgres `topics`.
 *
 * Scope: legacy `topic` WHERE network_id = 23410.
 * The new rows are attached to the local network whose code is `BB-TIMELINE`.
 * Idempotent via the `legacyId` unique column — safe to re-run.
 *
 *   pnpm tsx scripts/migrate-timeline-topics.ts
 */
import 'dotenv/config';
import type { RowDataPacket } from 'mysql2/promise';
import { PrismaClient } from '@prisma/client';
import { connectLegacyDb } from './legacy-db';

const LEGACY_NETWORK_ID = 23410;
const TARGET_NETWORK_CODE = 'BB-TIMELINE';

const prisma = new PrismaClient({ log: ['warn', 'error'] });

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function nonEmpty(value: any): string | null {
  if (value === null || value === undefined) return null;
  const v = String(value).trim();
  return v === '' ? null : v;
}

function date(value: any): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
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
    `SELECT topic_id, name, description, image_url, icon, icon_type, type, status, created
       FROM topic WHERE network_id = ?
       ORDER BY topic_id`,
    [LEGACY_NETWORK_ID],
  );
  log(`legacy rows fetched: ${rows.length}`);

  const legacyIds = rows.map((r) => Number(r.topic_id));
  const existing = new Set(
    (
      await prisma.topic.findMany({
        where: { legacyId: { in: legacyIds } },
        select: { legacyId: true },
      })
    ).map((t) => t.legacyId),
  );

  let created = 0;
  let updated = 0;
  let skippedNoName = 0;

  for (const r of rows) {
    const name = nonEmpty(r.name);
    if (!name) {
      skippedNoName++;
      continue;
    }
    const legacyId = Number(r.topic_id);
    // Legacy icon: emoji char (icon + icon_type='emoji') OR image (image_url).
    const iconType = nonEmpty(r.icon_type)?.toLowerCase() ?? null;
    const iconValue = iconType === 'emoji' ? nonEmpty(r.icon) : nonEmpty(r.image_url);
    const fields = {
      networkId: network.id,
      name,
      description: nonEmpty(r.description),
      iconUrl: iconValue,
      iconType: iconValue ? iconType : null,
      type: (nonEmpty(r.type) ?? 'PUBLIC').toUpperCase(),
      isActive: Number(r.status) === 1,
      createdAt: date(r.created),
    };
    await prisma.topic.upsert({
      where: { legacyId },
      create: { legacyId, ...fields },
      update: fields,
    });
    if (existing.has(legacyId)) updated++;
    else created++;
  }

  log(`topics: ${created} created, ${updated} updated, ${skippedNoName} skipped (no name)`);

  await legacy.end();
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
