/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
/**
 * One-shot setup: create the two BrainBoost networks the mobile app uses
 * (Timeline + Education) as local Postgres `networks` rows, carrying the
 * `code` + `purpose` that downstream migration scripts rely on.
 *
 * Why this exists
 * ---------------
 * `migrate-from-legacy.ts` (phase `networks`) bulk-imports EVERY legacy network
 * but never sets `code`. The two scripts that follow —
 *   - migrate-timeline-topics.ts  → findFirst({ code: 'BBTIMELN' })  (legacy 23410)
 *   - migrate-education-tags.ts    → findFirst({ code: 'BBEDUCAT' })  (legacy 25136)
 * both THROW "network not found" without these two coded rows. This script
 * fills that gap.
 *
 * Source: copies name/description/icon from the legacy `network` row when present
 * (so it stays in sync with the bulk import), otherwise falls back to a sane name.
 *
 * Idempotent: upsert keyed by `legacyId` — safe to re-run, and safe to run
 * before OR after migrate-from-legacy (it adopts the bulk-imported row by legacyId
 * and stamps `code` + `purpose` onto it).
 *
 *   pnpm tsx scripts/create-bb-networks.ts
 */
import 'dotenv/config';
import type { RowDataPacket } from 'mysql2/promise';
import { PrismaClient } from '@prisma/client';
import { connectLegacyDb } from './legacy-db';

// `code` is the canonical identity the mobile app resolves by (member.controller lists
// community networks by `purpose`; joins resolve by `code`). The prisma migration
// `seed_community_networks` already creates these two rows by code (with a placeholder
// legacyId 999000001/2). We ADOPT those rows by code and stamp the REAL legacy network id
// (23410/25136) so the downstream member/topic/post scripts map correctly — there must be
// exactly ONE network per purpose, never a second BBTIMELN/BBEDUCAT pair.
const NETWORKS = [
  { legacyId: 23410, code: 'BB-TIMELINE', purpose: 'timeline', fallbackName: 'BrainBoost Timeline' },
  { legacyId: 25136, code: 'BB-EDUCATION', purpose: 'education', fallbackName: 'BrainBoost Education' },
] as const;

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

async function main() {
  const legacy = await connectLegacyDb();
  const ids = NETWORKS.map((n) => n.legacyId);
  const [rows] = await legacy.query<RowDataPacket[]>(
    `SELECT network_id, name, biography, logo_image_url, status
       FROM network WHERE network_id IN (?)`,
    [ids],
  );
  await legacy.end();
  const byId = new Map<number, RowDataPacket>(rows.map((r) => [Number(r.network_id), r]));
  log(`legacy network rows fetched: ${rows.length}/${NETWORKS.length}`);

  for (const cfg of NETWORKS) {
    const legacyRow = byId.get(cfg.legacyId);
    if (!legacyRow) {
      log(`WARN legacy network ${cfg.legacyId} not found — using fallback name`);
    }
    const fields = {
      code: cfg.code,
      purpose: cfg.purpose,
      name: nonEmpty(legacyRow?.name) ?? cfg.fallbackName,
      description: nonEmpty(legacyRow?.biography),
      iconUrl: nonEmpty(legacyRow?.logo_image_url),
      isActive: legacyRow ? Number(legacyRow.status) === 1 : true,
    };
    // Adopt by CODE (the app-seeded row) and stamp the real legacyId — never create a
    // second row keyed by legacyId.
    const before = await prisma.network.findUnique({
      where: { code: cfg.code },
      select: { id: true },
    });
    const net = await prisma.network.upsert({
      where: { code: cfg.code },
      create: { legacyId: cfg.legacyId, ...fields },
      update: { legacyId: cfg.legacyId, ...fields },
    });
    log(`${cfg.code} (legacy ${cfg.legacyId}) ${before ? 'adopted' : 'created'} -> ${net.id} "${net.name}"`);
  }

  await prisma.$disconnect();
  log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
