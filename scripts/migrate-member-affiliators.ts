/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
/**
 * Migrate affiliate-program memberships: legacy member_product_affiliator -> MemberAffiliator.
 *
 *   pnpm tsx scripts/migrate-member-affiliators.ts [--dry-run]
 *
 * Run AFTER migrate-members + backfill:affiliate-program-product. Scoped to brainboost
 * programs (the linked/active ones) and to already-migrated members. A member's join is
 * the record behind "my affiliate programs" + a populated `affiliatorId` on commissions
 * (which is otherwise nullable). See docs/member-migration-plan.md §7.
 *
 * Resolution:
 *   legacy mpa.network_account_affiliator_id  -> network_account_affiliator.member_id (member)
 *   legacy mpa.network_account_product_affiliator_id (napa_id) == AffiliateProgram.legacyId
 *   member_id (after loser->winner redirect) == Member.legacyId
 * Keyed legacyId = member_product_affiliator_id; unique (memberId, programId).
 */
import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import type { RowDataPacket } from 'mysql2/promise';
import { PrismaClient } from '@prisma/client';
import { connectLegacyDb } from './legacy-db';

const REDIRECT_PATH = 'scripts/member-redirect.json';
const INSERT_CHUNK = 1000;

const prisma = new PrismaClient({ log: ['warn', 'error'] });
const dryRun = process.argv.includes('--dry-run');

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [migrate-member-affiliators] ${msg}`);
}
function bool(v: any): boolean {
  return v === 1 || v === true || v === '1';
}
function toDate(v: any): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
function loadRedirect(): Map<number, number> {
  const map = new Map<number, number>();
  if (!existsSync(REDIRECT_PATH)) return map;
  const raw = JSON.parse(readFileSync(REDIRECT_PATH, 'utf8')) as Record<string, number>;
  for (const [loser, winner] of Object.entries(raw)) map.set(Number(loser), Number(winner));
  return map;
}

async function main() {
  if (dryRun) log('DRY RUN — no writes to Postgres');
  const legacy = await connectLegacyDb({ dateStrings: false });
  log('connected to legacy mariadb');

  try {
    const redirect = loadRedirect();
    log(`redirect map: ${redirect.size}`);

    // new AffiliateProgram by legacyId (napa_id) — brainboost programs are the linked/active ones
    const programs = await prisma.affiliateProgram.findMany({
      where: { legacyId: { not: null }, productId: { not: null } },
      select: { id: true, legacyId: true },
    });
    const programByNapa = new Map<number, string>();
    for (const p of programs) if (p.legacyId !== null) programByNapa.set(p.legacyId, p.id);
    log(`linked programs (productId set): ${programByNapa.size}`);

    // new Member by legacyId
    const members = await prisma.member.findMany({
      where: { legacyId: { not: null } },
      select: { id: true, legacyId: true },
    });
    const memberByLegacy = new Map<number, string>();
    for (const m of members) if (m.legacyId !== null) memberByLegacy.set(m.legacyId, m.id);
    log(`migrated members: ${memberByLegacy.size}`);

    // legacy joins for those programs, resolving member via network_account_affiliator
    const napaIds = [...programByNapa.keys()];
    if (napaIds.length === 0) {
      log('no linked programs — run backfill:affiliate-program-product first. abort.');
      return;
    }

    const seenPair = new Set<string>(); // memberId|programId
    const data: any[] = [];
    let skipNoMember = 0;
    let skipDup = 0;
    for (let i = 0; i < napaIds.length; i += 500) {
      const chunk = napaIds.slice(i, i + 500);
      const [rows] = await legacy.query<RowDataPacket[]>(
        `SELECT mpa.member_product_affiliator_id AS mpa_id,
                mpa.network_account_product_affiliator_id AS napa_id,
                naa.member_id AS member_id,
                mpa.exit_state, mpa.exit_date, mpa.deleted, mpa.created
           FROM member_product_affiliator mpa
           JOIN network_account_affiliator naa
             ON naa.network_account_affiliator_id = mpa.network_account_affiliator_id
          WHERE mpa.network_account_product_affiliator_id IN (?)`,
        [chunk],
      );
      for (const r of rows as any[]) {
        const programId = programByNapa.get(Number(r.napa_id));
        if (!programId) continue;
        const legacyMember = Number(r.member_id);
        const winnerLegacy = redirect.get(legacyMember) ?? legacyMember;
        const memberId = memberByLegacy.get(winnerLegacy);
        if (!memberId) {
          skipNoMember += 1; // member not in scope / not migrated
          continue;
        }
        const key = `${memberId}|${programId}`;
        if (seenPair.has(key)) {
          skipDup += 1;
          continue;
        }
        seenPair.add(key);
        data.push({
          legacyId: Number(r.mpa_id),
          memberId,
          programId,
          isActive: !bool(r.deleted),
          exitState: r.exit_state ? String(r.exit_state) : null,
          exitAt: toDate(r.exit_date),
        });
      }
    }

    let inserted = 0;
    if (!dryRun) {
      for (let i = 0; i < data.length; i += INSERT_CHUNK) {
        const res = await prisma.memberAffiliator.createMany({
          data: data.slice(i, i + INSERT_CHUNK),
          skipDuplicates: true,
        });
        inserted += res.count;
      }
    }
    log(
      `DONE${dryRun ? ' (dry-run)' : ''} candidates=${data.length} ` +
        `inserted=${dryRun ? '(dry)' : inserted} skipNoMember=${skipNoMember} skipDupPair=${skipDup}`,
    );
  } finally {
    await legacy.end();
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
