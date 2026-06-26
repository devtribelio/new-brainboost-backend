/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
/**
 * Legacy KYC -> new Member.kyc* migration.
 *
 *   pnpm tsx scripts/migrate-kyc.ts [--dry-run]
 *
 * Carries the legacy KYC decision onto already-migrated members. Run AFTER
 * migrate:members (needs members + scripts/member-redirect.json present).
 *
 * SOURCE  = legacy `member_data_kyc` (the real KYC table written by tribelio-admin;
 *           NOT `member.last_kyc_status`, which is a stale denormalised cache).
 *           Latest row per member (MAX member_data_kyc_id) is authoritative.
 * SCOPE   = APPROVED + REJECTED only. PENDING (and any other value) is skipped →
 *           those members stay kycStatus=NONE so they re-KYC fresh via Sumsub.
 * REDIRECT= a loser's KYC is applied to its dedup winner (member-redirect.json),
 *           mirroring how enrollments merge to the winner. If both a loser and the
 *           winner have KYC rows, the globally-latest row across the cluster wins.
 * WRITES  = members.{kycStatus, kycSource='LEGACY', kycIdNumber=nik,
 *           kycReviewedAt=actionat, kycRejectedReason=reason(only REJECTED)}.
 * GUARD   = only overwrites members whose kycSource is still NONE or LEGACY, so a
 *           re-run never clobbers a MANUAL/SUMSUB decision made in the new system.
 * Idempotent: keyed by legacyId; safe to re-run.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { PrismaClient } from '@prisma/client';
import { connectLegacyDb } from './legacy-db';

const REDIRECT_PATH = 'scripts/member-redirect.json';
const CONCURRENCY = 100;

const prisma = new PrismaClient({ log: ['warn', 'error'] });
const dryRun = process.argv.includes('--dry-run');

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [migrate-kyc] ${msg}`);
}
function nonEmpty(v: any): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
function toDate(v: any): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

interface KycRow {
  id: number;
  legacyMemberId: number;
  status: 'APPROVED' | 'REJECTED';
  nik: string | null;
  reason: string | null;
  reviewedAt: Date | null;
}

async function main() {
  if (dryRun) log('DRY RUN — no writes to Postgres');
  const legacy = await connectLegacyDb({ dateStrings: false });
  log('connected to legacy mariadb');
  try {
    // loser legacyId -> winner legacyId
    let redirect = new Map<number, number>();
    try {
      const raw = JSON.parse(readFileSync(REDIRECT_PATH, 'utf8')) as Record<string, number>;
      redirect = new Map(Object.entries(raw).map(([k, v]) => [Number(k), Number(v)]));
      log(`redirect map: ${redirect.size} entries`);
    } catch {
      log(`WARN: ${REDIRECT_PATH} not found — proceeding without dedup redirect`);
    }

    // migrated members: legacyId -> new uuid
    const members = await prisma.member.findMany({
      where: { legacyId: { not: null } },
      select: { id: true, legacyId: true },
    });
    const memberByLegacy = new Map<number, string>();
    for (const m of members) if (m.legacyId !== null) memberByLegacy.set(m.legacyId, m.id);
    log(`migrated members: ${memberByLegacy.size}`);

    // latest member_data_kyc row per LEGACY member, APPROVED/REJECTED only
    const [rows] = await legacy.query<RowDataPacket[]>(
      `SELECT k.member_data_kyc_id, k.member_id, k.kyc_status, k.nik, k.reason,
              k.actionat, k.updated, k.created
         FROM member_data_kyc k
         JOIN (SELECT member_id, MAX(member_data_kyc_id) mx FROM member_data_kyc
                WHERE kyc_status IN ('APPROVED','REJECTED') GROUP BY member_id) t
           ON t.member_id = k.member_id AND t.mx = k.member_data_kyc_id`,
    );

    // resolve to dedup winner, then keep globally-latest row per winner legacyId
    const byWinner = new Map<number, KycRow>();
    let skippedOutOfScope = 0;
    for (const r of rows as any[]) {
      const status = String(r.kyc_status) as 'APPROVED' | 'REJECTED';
      const legacyMemberId = Number(r.member_id);
      const winnerLegacy = redirect.get(legacyMemberId) ?? legacyMemberId;
      if (!memberByLegacy.has(winnerLegacy)) {
        skippedOutOfScope += 1;
        continue;
      }
      const row: KycRow = {
        id: Number(r.member_data_kyc_id),
        legacyMemberId: winnerLegacy,
        status,
        nik: nonEmpty(r.nik),
        reason: status === 'REJECTED' ? nonEmpty(r.reason) : null,
        reviewedAt: toDate(r.actionat) ?? toDate(r.updated) ?? toDate(r.created),
      };
      const prev = byWinner.get(winnerLegacy);
      if (!prev || row.id > prev.id) byWinner.set(winnerLegacy, row);
    }

    const targets = [...byWinner.values()];
    const approved = targets.filter((t) => t.status === 'APPROVED').length;
    const rejected = targets.length - approved;
    log(
      `resolved: in-scope members with KYC=${targets.length} ` +
        `(APPROVED=${approved} REJECTED=${rejected}) skippedOutOfScope=${skippedOutOfScope}`,
    );

    if (dryRun) {
      for (const t of targets.slice(0, 3))
        log(`sample legacyId=${t.legacyMemberId} status=${t.status} nik=${t.nik ? 'set' : 'none'} reviewedAt=${t.reviewedAt?.toISOString() ?? 'null'}`);
      log('DONE (dry-run)');
      return;
    }

    // apply (guarded so a re-run never clobbers MANUAL/SUMSUB)
    let updated = 0;
    let skippedGuard = 0;
    for (let i = 0; i < targets.length; i += CONCURRENCY) {
      const batch = targets.slice(i, i + CONCURRENCY);
      const res = await Promise.all(
        batch.map((t) => {
          const id = memberByLegacy.get(t.legacyMemberId)!;
          return prisma.member.updateMany({
            where: { id, kycSource: { in: ['NONE', 'LEGACY'] } },
            data: {
              kycStatus: t.status,
              kycSource: 'LEGACY',
              kycIdNumber: t.nik,
              kycReviewedAt: t.reviewedAt,
              kycRejectedReason: t.reason,
            },
          });
        }),
      );
      for (const r of res) {
        if (r.count > 0) updated += r.count;
        else skippedGuard += 1;
      }
    }
    log(`DONE updated=${updated} skippedGuard(MANUAL/SUMSUB)=${skippedGuard}`);
  } finally {
    await legacy.end();
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
