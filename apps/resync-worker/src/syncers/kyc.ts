/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * KYC syncer — incremental port of scripts/migrate-kyc.ts.
 *
 * SOURCE  legacy `member_data_kyc` (real KYC table; member.last_kyc_status is stale).
 * CHANGE  any row with COALESCE(updated,created) > watermark re-evaluates that member.
 * AUTH    latest APPROVED/REJECTED row across the dedup cluster wins (MAX id).
 * GUARD   only writes members whose kycSource is still NONE/LEGACY — never clobbers a
 *         MANUAL/SUMSUB decision, never downgrades an EXPIRED (re-KYC in progress).
 * See docs/specs/legacy-resync-plan.md §6.
 */
import type { RowDataPacket } from 'mysql2/promise';
import { emptyStats, type RunCtx, type Stats, type Syncer, type SyncerCtx } from '../types';
import { maxWatermark, nonEmpty, sinceBound, toDate } from '../util';

interface KycTarget {
  id: number; // member_data_kyc_id (latest in cluster)
  winnerLegacy: number;
  status: 'APPROVED' | 'REJECTED';
  nik: string | null;
  reason: string | null;
  reviewedAt: Date | null;
  // payout account from the APPROVED submission (legacy naming: bank_type = bank code,
  // bank_name = ACCOUNT HOLDER name, bank_number = account number). null on REJECTED.
  bankCode: string | null;
  bankAccountNumber: string | null;
  bankAccountName: string | null;
}

/** winner legacyId -> all legacy member ids in its dedup cluster (winner + losers). */
function clusterMap(redirect: Map<number, number>): Map<number, Set<number>> {
  const m = new Map<number, Set<number>>();
  const add = (winner: number, member: number) => {
    let s = m.get(winner);
    if (!s) m.set(winner, (s = new Set()));
    s.add(member);
  };
  for (const [loser, winner] of redirect) {
    add(winner, winner);
    add(winner, loser);
  }
  return m;
}

/**
 * Re-evaluate + apply the authoritative legacy KYC decision for the given legacy member
 * ids (cluster-widened, guard: kycSource NONE/LEGACY only). Shared by the syncer (ids =
 * members whose member_data_kyc changed) and the backfill pass (ids = members
 * materialised this run — their KYC rows predate any watermark).
 */
export async function applyKycDecisions(ctx: RunCtx, memberLegacyIds: number[], stats: Stats): Promise<void> {
  // widen to full dedup clusters of the affected winners, so a changed loser
  // re-evaluates against the cluster-latest authoritative row.
  const clusters = clusterMap(ctx.redirect);
  const relevant = new Set<number>();
  for (const cm of memberLegacyIds) {
    const winner = ctx.redirect.get(cm) ?? cm;
    relevant.add(winner);
    for (const id of clusters.get(winner) ?? [winner]) relevant.add(id);
  }
  const ids = [...relevant];

  // latest APPROVED/REJECTED row per legacy member (chunked IN)
  const byWinner = new Map<number, KycTarget>();
  for (let i = 0; i < ids.length; i += 5000) {
    const chunk = ids.slice(i, i + 5000);
    const [rows] = await ctx.legacy.query<RowDataPacket[]>(
      `SELECT k.member_data_kyc_id, k.member_id, k.kyc_status, k.nik, k.reason,
              k.actionat, k.\`updated\`, k.\`created\`,
              k.bank_type, k.bank_name, k.bank_number
         FROM member_data_kyc k
         JOIN (SELECT member_id, MAX(member_data_kyc_id) mx FROM member_data_kyc
                WHERE kyc_status IN ('APPROVED','REJECTED') AND member_id IN (?)
                GROUP BY member_id) t
           ON t.member_id = k.member_id AND t.mx = k.member_data_kyc_id`,
      [chunk],
    );
    for (const r of rows as any[]) {
      const winnerLegacy = ctx.redirect.get(Number(r.member_id)) ?? Number(r.member_id);
      if (!ctx.memberByLegacy.has(winnerLegacy)) {
        stats.skipped += 1;
        continue;
      }
      const status = String(r.kyc_status) as 'APPROVED' | 'REJECTED';
      const bankOk = status === 'APPROVED' && nonEmpty(r.bank_number) !== null;
      const target: KycTarget = {
        id: Number(r.member_data_kyc_id),
        winnerLegacy,
        status,
        nik: nonEmpty(r.nik),
        reason: status === 'REJECTED' ? nonEmpty(r.reason) : null,
        reviewedAt: toDate(r.actionat) ?? toDate(r.updated) ?? toDate(r.created),
        bankCode: bankOk ? nonEmpty(r.bank_type) : null,
        bankAccountNumber: bankOk ? nonEmpty(r.bank_number) : null,
        bankAccountName: bankOk ? nonEmpty(r.bank_name) : null,
      };
      const prev = byWinner.get(winnerLegacy);
      if (!prev || target.id > prev.id) byWinner.set(winnerLegacy, target);
    }
  }

  // apply (guarded). dry-run reports only.
  if (ctx.dryRun) {
    stats.upserted += byWinner.size;
    ctx.log(`(dry) would apply ${byWinner.size} KYC decisions`);
    return;
  }

  const targets = [...byWinner.values()];
  let bankFilled = 0;
  for (let i = 0; i < targets.length; i += 100) {
    const batch = targets.slice(i, i + 100);
    const res = await Promise.all(
      batch.map((t) =>
        ctx.prisma.member.updateMany({
          where: { id: ctx.memberByLegacy.get(t.winnerLegacy)!, kycSource: { in: ['NONE', 'LEGACY'] } },
          data: {
            kycStatus: t.status,
            kycSource: 'LEGACY',
            kycIdNumber: t.nik,
            kycReviewedAt: t.reviewedAt,
            kycRejectedReason: t.reason,
          },
        }),
      ),
    );
    for (const r of res) {
      if (r.count > 0) stats.upserted += r.count;
      else stats.skipped += 1; // guard-blocked (MANUAL/SUMSUB/EXPIRED)
    }
    // payout account from the APPROVED submission — fill-if-NULL only (never overwrite an
    // app-set account → also never trips the BANK_CHANGE re-KYC semantics). Independent of
    // the kycSource guard: bank data is provider-agnostic.
    const bankRes = await Promise.all(
      batch
        .filter((t) => t.bankAccountNumber !== null)
        .map((t) =>
          ctx.prisma.member.updateMany({
            where: { id: ctx.memberByLegacy.get(t.winnerLegacy)!, bankAccountNumber: null },
            data: {
              bankCode: t.bankCode,
              bankAccountNumber: t.bankAccountNumber,
              bankAccountName: t.bankAccountName,
            },
          }),
        ),
    );
    for (const r of bankRes) bankFilled += r.count;
  }
  if (bankFilled) ctx.log(`bank account filled from legacy KYC on ${bankFilled} members`);
}

export const kycSyncer: Syncer = {
  name: 'kyc',
  async run(ctx: SyncerCtx): Promise<Stats> {
    const stats = emptyStats();
    const since = sinceBound(ctx.since);

    // 1) members whose KYC changed since the watermark
    const [changed] = await ctx.legacy.query<RowDataPacket[]>(
      `SELECT member_id, MAX(COALESCE(\`updated\`, \`created\`)) AS wm
         FROM member_data_kyc
        WHERE COALESCE(\`updated\`, \`created\`) > ?
        GROUP BY member_id`,
      [since],
    );
    stats.scanned = (changed as any[]).length;
    if (!stats.scanned) return stats;

    let watermark = ctx.since;
    const changedMembers: number[] = [];
    for (const r of changed as any[]) {
      changedMembers.push(Number(r.member_id));
      watermark = maxWatermark(watermark, toDate(r.wm));
    }

    // 2-4) cluster-widen, pick authoritative row, apply guarded
    await applyKycDecisions(ctx, changedMembers, stats);

    if (watermark && !ctx.dryRun) await ctx.checkpoint(watermark);
    return stats;
  },
};
