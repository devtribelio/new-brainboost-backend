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
 * structure), so no new-wins gate here. See docs/legacy-resync-plan.md §6.
 */
import type { RowDataPacket } from 'mysql2/promise';
import { emptyStats, type Stats, type Syncer, type SyncerCtx } from '../types';
import { bool, maxWatermark, nonEmpty, sinceBound, toDate } from '../util';

const PAGE = 5000;

/** legacy member_network.member_network_id (node) -> member_id, for the given nodes. */
async function resolveNodes(ctx: SyncerCtx, nodeIds: number[]): Promise<Map<number, number>> {
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

async function syncInviters(ctx: SyncerCtx, since: Date, stats: Stats): Promise<string | null> {
  // Only set inviter on ALREADY-migrated members. `member_network` is the GLOBAL affiliate
  // tree (~700k rows for the whole legacy base), NOT a brainboost-scope signal — so we scope
  // the scan to our migrated member_ids (PK-indexed IN) and NEVER create members here
  // (using ensureMember would materialise the entire legacy base). New brainboost members are
  // created by the scoped syncers (enrollments / tree-affiliators / posts / reviews) and are
  // already in the map by the time this runs.
  const legacyIds = [...ctx.memberByLegacy.keys()];
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

    for (const r of rows as any[]) {
      stats.scanned += 1;
      watermark = maxWatermark(watermark, toDate(r.wm));
      const subjectId = ctx.memberByLegacy.get(Number(r.member_id)); // migrated only (no create)
      if (!subjectId) {
        stats.skipped += 1;
        continue;
      }
      let inviterId: string | undefined;
      if (r.parent_id != null) {
        const invMember = nodeToMember.get(Number(r.parent_id));
        if (invMember != null) inviterId = ctx.resolveMember(invMember);
      }
      if (ctx.dryRun) {
        stats.upserted += 1;
        continue;
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
    }
  }
  // checkpoint once after all chunks (interruption re-runs the bounded syncer idempotently)
  return watermark;
}

async function syncAffiliators(ctx: SyncerCtx, since: Date, stats: Stats): Promise<string | null> {
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
          AND COALESCE(mpa.\`updated\`, mpa.\`created\`) > ?`,
      [chunk, since],
    );
    for (const r of rows as any[]) {
      stats.scanned += 1;
      watermark = maxWatermark(watermark, toDate(r.wm));
      const programId = programByNapa.get(Number(r.napa_id));
      const memberId = await ctx.ensureMember(Number(r.member_id));
      if (!programId || !memberId) {
        stats.skipped += 1;
        continue;
      }
      const isActive = !bool(r.deleted);
      if (!isActive) stats.voided = (stats.voided ?? 0) + 1;
      if (ctx.dryRun) {
        stats.upserted += 1;
        continue;
      }
      const legacyId = Number(r.mpa_id);
      const pairKey = `${memberId}|${programId}`;
      const existing = byPair.get(pairKey);
      const fields = { isActive, exitState: r.exit_state ? String(r.exit_state) : null, exitAt: toDate(r.exit_date) };
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
          byPair.set(pairKey, { id: 'new', legacyId });
          stats.upserted += 1;
        }
      } catch (err: any) {
        if (err?.code === 'P2002') stats.skipped += 1;
        else stats.errors += 1;
      }
    }
  }
  return watermark;
}

export const treeSyncer: Syncer = {
  name: 'tree',
  async run(ctx: SyncerCtx): Promise<Stats> {
    const stats = emptyStats();
    const since = sinceBound(ctx.since);
    const wmA = await syncInviters(ctx, since, stats);
    const wmB = await syncAffiliators(ctx, since, stats);
    const watermark = maxWatermark(wmA, wmB ? new Date(wmB) : null);
    if (watermark && !ctx.dryRun) await ctx.checkpoint(watermark);
    return stats;
  },
};
