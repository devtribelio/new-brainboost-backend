/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * KYC syncer — incremental port of scripts/migrate-kyc.ts.
 *
 * SOURCE  legacy `member_data_kyc` (real KYC table; member.last_kyc_status is stale).
 * CHANGE  any row with COALESCE(updated,created) > watermark re-evaluates that member.
 * AUTH    latest APPROVED/REJECTED row across the dedup cluster wins (MAX id).
 * GUARD   only writes members whose kycSource is still NONE/LEGACY — never clobbers a
 *         MANUAL/SUMSUB decision, never downgrades an EXPIRED (re-KYC in progress).
 * See docs/legacy-resync-plan.md §6.
 */
import type { RowDataPacket } from 'mysql2/promise';
import { emptyStats, type Stats, type Syncer, type SyncerCtx } from '../types';
import { maxWatermark, nonEmpty, sinceBound, toDate } from '../util';

interface KycTarget {
  id: number; // member_data_kyc_id (latest in cluster)
  winnerLegacy: number;
  status: 'APPROVED' | 'REJECTED';
  nik: string | null;
  reason: string | null;
  reviewedAt: Date | null;
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

    // 2) widen to full dedup clusters of the affected winners, so a changed loser
    //    re-evaluates against the cluster-latest authoritative row.
    const clusters = clusterMap(ctx.redirect);
    const relevant = new Set<number>();
    for (const cm of changedMembers) {
      const winner = ctx.redirect.get(cm) ?? cm;
      relevant.add(winner);
      for (const id of clusters.get(winner) ?? [winner]) relevant.add(id);
    }
    const ids = [...relevant];

    // 3) latest APPROVED/REJECTED row per legacy member (chunked IN)
    const byWinner = new Map<number, KycTarget>();
    for (let i = 0; i < ids.length; i += 5000) {
      const chunk = ids.slice(i, i + 5000);
      const [rows] = await ctx.legacy.query<RowDataPacket[]>(
        `SELECT k.member_data_kyc_id, k.member_id, k.kyc_status, k.nik, k.reason,
                k.actionat, k.\`updated\`, k.\`created\`
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
        const target: KycTarget = {
          id: Number(r.member_data_kyc_id),
          winnerLegacy,
          status,
          nik: nonEmpty(r.nik),
          reason: status === 'REJECTED' ? nonEmpty(r.reason) : null,
          reviewedAt: toDate(r.actionat) ?? toDate(r.updated) ?? toDate(r.created),
        };
        const prev = byWinner.get(winnerLegacy);
        if (!prev || target.id > prev.id) byWinner.set(winnerLegacy, target);
      }
    }

    // 4) apply (guarded). dry-run reports only.
    if (ctx.dryRun) {
      stats.upserted = byWinner.size;
      ctx.log(`(dry) would apply ${byWinner.size} KYC decisions`);
      return stats;
    }

    const targets = [...byWinner.values()];
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
    }

    if (watermark) await ctx.checkpoint(watermark);
    return stats;
  },
};
