/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tree syncer — incremental port of backfill-affiliate-tree.ts + migrate-member-affiliators.ts.
 *
 * A) inviter chain: legacy member_network.parent_id (a NODE id) → node's member → winner →
 *    Member.inviterId; plus affiliateBased + affiliateCode. Subject must be a migrated
 *    winner (we never overwrite a winner's inviter from a redirected loser's row).
 * B) program memberships: legacy member_product_affiliator → MemberAffiliator (key legacyId,
 *    unique (memberId, programId)); deleted/exit rides the `updated` watermark → isActive=false.
 *
 * Tree is legacy-authoritative for migrated members (the new app doesn't edit referral
 * structure), so no new-wins gate here. See docs/specs/legacy-resync-plan.md §6.
 */
import type { RowDataPacket } from 'mysql2/promise';
import { resyncConfig } from '../config';
import { emptyStats, type RunCtx, type Stats, type Syncer, type SyncerCtx } from '../types';
import { bool, maxWatermark, nonEmpty, runConcurrent, sinceBound, toDate } from '../util';

const PAGE = 5000;

/** Keep one row per key — the one with the largest watermark (last write wins, deterministic). */
function dedupeByKey<T>(rows: T[], keyOf: (r: T) => string | number, stats: Stats): T[] {
  const best = new Map<string | number, T>();
  for (const r of rows) {
    const k = keyOf(r);
    const prev = best.get(k);
    if (!prev || (toDate((r as any).wm)?.getTime() ?? 0) >= (toDate((prev as any).wm)?.getTime() ?? 0)) {
      best.set(k, r);
    }
  }
  const out = [...best.values()];
  stats.skipped += rows.length - out.length; // in-batch duplicates superseded by a newer row
  return out;
}

/** legacy member_network.member_network_id (node) -> member_id, for the given nodes. */
async function resolveNodes(ctx: RunCtx, nodeIds: number[]): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  for (let i = 0; i < nodeIds.length; i += 5000) {
    const chunk = nodeIds.slice(i, i + 5000);
    if (!chunk.length) continue;
    const [rows] = await ctx.legacy.query<RowDataPacket[]>(
      'SELECT member_network_id, member_id FROM member_network WHERE member_network_id IN (?)',
      [chunk],
    );
    for (const r of rows as any[]) if (r.member_id != null) map.set(Number(r.member_network_id), Number(r.member_id));
  }
  return map;
}

/**
 * Inviter-chain sync for an explicit set of migrated legacy member ids.
 * Called by the syncer (all migrated ids, watermark-bounded) AND by the backfill pass
 * (just-created members, since=epoch — their member_network rows predate any watermark).
 */
export async function syncInvitersScoped(
  ctx: RunCtx & { since: string | null },
  legacyIds: number[],
  since: Date,
  stats: Stats,
): Promise<string | null> {
  let watermark = ctx.since;

  for (let i = 0; i < legacyIds.length; i += PAGE) {
    const idChunk = legacyIds.slice(i, i + PAGE);
    const [rows] = await ctx.legacy.query<RowDataPacket[]>(
      `SELECT mn.member_network_id, mn.member_id, mn.parent_id, mn.affiliate_based,
              m.affiliator_code, COALESCE(mn.\`updated\`, mn.\`created\`) AS wm
         FROM member_network mn JOIN member m ON m.member_id = mn.member_id
        WHERE mn.member_id IN (?) AND COALESCE(mn.\`updated\`, mn.\`created\`) > ?`,
      [idChunk, since],
    );
    if ((rows as any[]).length === 0) continue;

    const parentIds = [...new Set((rows as any[]).map((r) => (r.parent_id != null ? Number(r.parent_id) : 0)).filter(Boolean))];
    const nodeToMember = await resolveNodes(ctx, parentIds);

    stats.scanned += (rows as any[]).length;
    for (const r of rows as any[]) watermark = maxWatermark(watermark, toDate(r.wm));
    // a member can hold several member_network nodes → concurrent updates to the same
    // member would be last-write-wins by chance; keep only the newest row per member
    const subjects = dedupeByKey(rows as any[], (r: any) => Number(r.member_id), stats);

    await runConcurrent(subjects, resyncConfig.writeConcurrency, async (r: any) => {
      const subjectId = ctx.memberByLegacy.get(Number(r.member_id)); // migrated only (no create)
      if (!subjectId) {
        stats.skipped += 1;
        return;
      }
      let inviterId: string | undefined;
      if (r.parent_id != null) {
        const invMember = nodeToMember.get(Number(r.parent_id));
        if (invMember != null) inviterId = ctx.resolveMember(invMember);
      }
      if (ctx.dryRun) {
        stats.upserted += 1;
        return;
      }
      const base = {
        inviterId: inviterId ?? null,
        affiliateBased: nonEmpty(r.affiliate_based) ?? 'PERFORMANCE',
      };
      const code = nonEmpty(r.affiliator_code);
      try {
        await ctx.prisma.member.update({
          where: { id: subjectId },
          data: code ? { ...base, affiliateCode: code } : base,
        });
        stats.upserted += 1;
      } catch (err: any) {
        if (err?.code === 'P2002' && code) {
          // affiliateCode collision — keep tree fields, drop the code
          try {
            await ctx.prisma.member.update({ where: { id: subjectId }, data: base });
            stats.upserted += 1;
          } catch {
            stats.errors += 1;
          }
        } else {
          stats.errors += 1;
        }
      }
    });
  }
  // checkpoint once after all chunks (interruption re-runs the bounded syncer idempotently)
  return watermark;
}

async function syncInviters(ctx: SyncerCtx, since: Date, stats: Stats): Promise<string | null> {
  // Only set inviter on ALREADY-migrated members. `member_network` is the GLOBAL affiliate
  // tree (~700k rows for the whole legacy base), NOT a brainboost-scope signal — so we scope
  // the scan to our migrated member_ids (PK-indexed IN) and NEVER create members here
  // (using ensureMember would materialise the entire legacy base). New brainboost members are
  // created by the scoped syncers (enrollments / tree-affiliators / posts / reviews); members
  // materialised AFTER this syncer ran are covered by the end-of-run backfill pass.
  return syncInvitersScoped(ctx, [...ctx.memberByLegacy.keys()], since, stats);
}

/**
 * Program-membership sync. `memberLegacyIds` (backfill mode) narrows the scan to those
 * members' rows; undefined = watermark-driven full scan (the syncer).
 */
export async function syncAffiliatorsScoped(
  ctx: RunCtx & { since: string | null },
  since: Date,
  stats: Stats,
  memberLegacyIds?: number[],
): Promise<string | null> {
  // linked brainboost programs: legacy napa_id -> AffiliateProgram.id
  const programByNapa = new Map<number, string>();
  for (const p of await ctx.prisma.affiliateProgram.findMany({
    where: { legacyId: { not: null }, productId: { not: null } },
    select: { id: true, legacyId: true },
  })) {
    if (p.legacyId !== null) programByNapa.set(p.legacyId, p.id);
  }
  const napaIds = [...programByNapa.keys()];
  if (!napaIds.length) return ctx.since;
  if (memberLegacyIds && !memberLegacyIds.length) return ctx.since;

  // MemberAffiliator carries both a legacyId unique AND a (memberId,programId) unique —
  // upserting on legacyId can collide on the pair (loser+winner in the same program).
  // Decide update/create/skip in memory so no P2002 is thrown.
  const byPair = new Map<string, { id: string; legacyId: number | null }>();
  for (const a of await ctx.prisma.memberAffiliator.findMany({
    select: { id: true, memberId: true, programId: true, legacyId: true },
  })) {
    byPair.set(`${a.memberId}|${a.programId}`, { id: a.id, legacyId: a.legacyId });
  }

  let watermark = ctx.since;
  for (let i = 0; i < napaIds.length; i += 500) {
    const chunk = napaIds.slice(i, i + 500);
    const memberFilter = memberLegacyIds ? ' AND naa.member_id IN (?)' : '';
    const params: unknown[] = memberLegacyIds ? [chunk, since, memberLegacyIds] : [chunk, since];
    const [rows] = await ctx.legacy.query<RowDataPacket[]>(
      `SELECT mpa.member_product_affiliator_id AS mpa_id,
              mpa.network_account_product_affiliator_id AS napa_id,
              naa.member_id AS member_id,
              mpa.exit_state, mpa.exit_date, mpa.deleted,
              COALESCE(mpa.\`updated\`, mpa.\`created\`) AS wm
         FROM member_product_affiliator mpa
         JOIN network_account_affiliator naa
           ON naa.network_account_affiliator_id = mpa.network_account_affiliator_id
        WHERE mpa.network_account_product_affiliator_id IN (?)
          AND COALESCE(mpa.\`updated\`, mpa.\`created\`) > ?${memberFilter}`,
      params,
    );
    await runConcurrent(rows as any[], resyncConfig.writeConcurrency, async (r: any) => {
      stats.scanned += 1;
      watermark = maxWatermark(watermark, toDate(r.wm));
      const programId = programByNapa.get(Number(r.napa_id));
      const memberId = await ctx.ensureMember(Number(r.member_id));
      if (!programId || !memberId) {
        stats.skipped += 1;
        return;
      }
      const isActive = !bool(r.deleted);
      if (!isActive) stats.voided = (stats.voided ?? 0) + 1;
      if (ctx.dryRun) {
        stats.upserted += 1;
        return;
      }
      const legacyId = Number(r.mpa_id);
      const pairKey = `${memberId}|${programId}`;
      const fields = { isActive, exitState: r.exit_state ? String(r.exit_state) : null, exitAt: toDate(r.exit_date) };
      // read-decide-claim is one synchronous block (no await inside) so a concurrent row
      // for the same pair deterministically sees the claim and skips instead of racing.
      const existing = byPair.get(pairKey);
      if (!existing) byPair.set(pairKey, { id: 'new', legacyId });
      try {
        if (existing) {
          // pair already joined → update its state only when this row IS that join (same
          // legacyId); a different legacyId for the same pair is a dup → skip.
          if (existing.legacyId === legacyId) {
            await ctx.prisma.memberAffiliator.update({ where: { id: existing.id }, data: fields });
            stats.upserted += 1;
          } else {
            stats.skipped += 1;
          }
        } else {
          await ctx.prisma.memberAffiliator.create({ data: { legacyId, memberId, programId, ...fields } });
          stats.upserted += 1;
        }
      } catch (err: any) {
        if (err?.code === 'P2002') stats.skipped += 1;
        else stats.errors += 1;
      }
    });
  }
  return watermark;
}

export const treeSyncer: Syncer = {
  name: 'tree',
  async run(ctx: SyncerCtx): Promise<Stats> {
    const stats = emptyStats();
    const since = sinceBound(ctx.since);
    const wmA = await syncInviters(ctx, since, stats);
    const wmB = await syncAffiliatorsScoped(ctx, since, stats);
    const watermark = maxWatermark(wmA, wmB ? new Date(wmB) : null);
    if (watermark && !ctx.dryRun) await ctx.checkpoint(watermark);
    return stats;
  },
};
