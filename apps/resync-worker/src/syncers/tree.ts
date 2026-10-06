/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tree syncer — incremental port of backfill-affiliate-tree.ts + migrate-member-affiliators.ts.
 *
 * A) inviter chain: legacy member_network.parent_id (a NODE id) → node's member → winner →
 *    Member.inviterId; plus affiliateBased + affiliateCode. Subject must be a migrated
 *    winner (we never overwrite a winner's inviter from a redirected loser's row).
 * B) program memberships: legacy member_product_affiliator → MemberAffiliator (key legacyId,
 *    unique (memberId, programId)); a kick (status=0 + exit/delete stamps) rides the `updated`
 *    watermark → isActive=false, and a re-join's NEW legacy row re-points the pair
 *    (see ./affiliator-rules.ts).
 *
 * Inviter writes are gated by members.inviter_source (see ./inviter-rules.ts): the tree
 * only overwrites an inviter it owns (NULL / LEGACY_PARENT) — the new app writes
 * inviterId too (register, affiliate connect → 'APP') and that wins. A parent that
 * resolves to the subject itself (dedup alias) is climbed past; a candidate that would
 * close a cycle is rejected. See docs/legacy-resync-plan.md §6.
 */
import type { RowDataPacket } from 'mysql2/promise';
import { resyncConfig } from '../config';
import { emptyStats, type RunCtx, type Stats, type Syncer, type SyncerCtx } from '../types';
import { errCode, nonEmpty, runConcurrent, sinceBound, toDate, WatermarkTracker } from '../util';
import { decideAffiliatorWrite, isLegacyAffiliatorActive, prefersAffiliatorRow } from './affiliator-rules';
import { syncLegacyAffiliateCode } from '../affiliate-code-sync';
import {
  CYCLE_CHECK_LEVELS,
  INVITER_SOURCE,
  MAX_CLIMB_HOPS,
  chainHitsSubject,
  mayOverwriteInviter,
  pickInviter,
  planInviterWrite,
  type InviterPick,
} from './inviter-rules';

const PAGE = 5000;

const legacyState = (r: any) => ({ status: r.status, exitState: r.exit_state, deleted: r.deleted, deleteAt: r.delete_at });

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

interface LegacyNode {
  memberId: number | null;
  parentId: number | null;
}

/** legacy member_network.member_network_id (node) -> { member_id, parent_id }, for the given nodes. */
async function fetchNodes(ctx: RunCtx, nodeIds: number[]): Promise<Map<number, LegacyNode>> {
  const map = new Map<number, LegacyNode>();
  for (let i = 0; i < nodeIds.length; i += 5000) {
    const chunk = nodeIds.slice(i, i + 5000);
    if (!chunk.length) continue;
    const [rows] = await ctx.legacy.query<RowDataPacket[]>(
      'SELECT member_network_id, member_id, parent_id FROM member_network WHERE member_network_id IN (?)',
      [chunk],
    );
    for (const r of rows as any[]) {
      map.set(Number(r.member_network_id), {
        memberId: r.member_id != null ? Number(r.member_id) : null,
        parentId: r.parent_id != null ? Number(r.parent_id) : null,
      });
    }
  }
  return map;
}

/**
 * Resolve the subject's legacy parent node to an inviter. When the node's member resolves
 * to the subject itself (a dedup loser of the same person, or another node of the
 * subject), climb to that node's parent, up to MAX_CLIMB_HOPS. `legacyChain` = legacy
 * member ids visited, for the log line.
 */
async function resolveInviter(
  ctx: RunCtx,
  subjectId: string,
  parentNodeId: number,
  nodes: Map<number, LegacyNode>,
): Promise<{ pick: InviterPick; legacyChain: Array<number | null> }> {
  const ancestors: Array<string | undefined> = [];
  const legacyChain: Array<number | null> = [];
  let nodeId: number | null = parentNodeId;
  for (let hop = 0; hop <= MAX_CLIMB_HOPS && nodeId != null; hop += 1) {
    // direct parents are prefetched per chunk; climbed nodes are rare → fetched one by one
    const node: LegacyNode | undefined = nodes.get(nodeId) ?? (await fetchNodes(ctx, [nodeId])).get(nodeId);
    legacyChain.push(node?.memberId ?? null);
    const memberId = node?.memberId != null ? ctx.resolveMember(node.memberId) : undefined;
    ancestors.push(memberId);
    if (memberId !== subjectId) break;
    nodeId = node?.parentId ?? null;
  }
  return { pick: pickInviter(subjectId, ancestors), legacyChain };
}

/** True when `candidateId`'s PG inviter chain reaches `subjectId` within CYCLE_CHECK_LEVELS. */
async function wouldCloseCycle(ctx: RunCtx, subjectId: string, candidateId: string): Promise<boolean> {
  const rows = await ctx.prisma.$queryRaw<Array<{ inviterId: string | null }>>`
    WITH RECURSIVE up AS (
      SELECT inviter_id, 1 AS lvl FROM members WHERE id = ${candidateId}::uuid
      UNION ALL
      SELECT m.inviter_id, up.lvl + 1 FROM members m JOIN up ON m.id = up.inviter_id
       WHERE up.lvl < ${CYCLE_CHECK_LEVELS}
    )
    SELECT inviter_id::text AS "inviterId" FROM up ORDER BY lvl`;
  return chainHitsSubject(
    subjectId,
    rows.map((r) => r.inviterId),
  );
}

/**
 * Inviter-chain sync for an explicit set of migrated legacy member ids.
 * Called by the syncer (all migrated ids, watermark-bounded) AND by the backfill pass
 * (just-created members, since=epoch — their member_network rows predate any watermark).
 * Rows are folded into `wm` (the syncer's checkpoint; backfill passes none).
 */
export async function syncInvitersScoped(
  ctx: RunCtx & { since: string | null },
  legacyIds: number[],
  since: Date,
  stats: Stats,
  wm = new WatermarkTracker(),
): Promise<void> {

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
    const nodes = await fetchNodes(ctx, parentIds);

    stats.scanned += (rows as any[]).length;
    for (const r of rows as any[]) wm.seen(toDate(r.wm));
    // a member can hold several member_network nodes → concurrent updates to the same
    // member would be last-write-wins by chance; keep only the newest row per member
    const subjects = dedupeByKey(rows as any[], (r: any) => Number(r.member_id), stats);

    const subjectIds = subjects
      .map((r: any) => ctx.memberByLegacy.get(Number(r.member_id)))
      .filter((id): id is string => id !== undefined);
    const current = new Map<string, { inviterId: string | null; inviterSource: string | null }>();
    for (const m of await ctx.prisma.member.findMany({
      where: { id: { in: subjectIds } },
      select: { id: true, inviterId: true, inviterSource: true },
    })) {
      current.set(m.id, { inviterId: m.inviterId, inviterSource: m.inviterSource });
    }

    await runConcurrent(subjects, resyncConfig.writeConcurrency, async (r: any) => {
      const subjectId = ctx.memberByLegacy.get(Number(r.member_id)); // migrated only (no create)
      const cur = subjectId ? current.get(subjectId) : undefined;
      if (!subjectId || !cur) {
        stats.skipped += 1;
        return;
      }
      // legacy parent present but not resolvable to a Member yet? LEAVE the current
      // inviterId alone. Writing null here is destructive and order-dependent: this
      // function runs BEFORE syncAffiliatorsScoped (the step that can materialise a
      // member), so an inviter first created later in the same run would wipe every
      // downline's chain — which is exactly how ~4k inviter links were lost on the
      // 2026-07-09 run. A legacy row with NO parent leaves it alone too (never NULL over
      // a non-null inviter); the only NULL ever written clears a self-inviter.
      let pick: InviterPick | null = null;
      let legacyChain: Array<number | null> = [];
      if (r.parent_id != null && mayOverwriteInviter(cur.inviterSource)) {
        ({ pick, legacyChain } = await resolveInviter(ctx, subjectId, Number(r.parent_id), nodes));
      }
      if (pick?.status === 'unresolved') stats.skipped += 1;
      const createsCycle = pick?.status === 'ok' ? await wouldCloseCycle(ctx, subjectId, pick.inviterId) : false;
      const plan = planInviterWrite({ subjectId, current: cur, pick, createsCycle });
      if (plan.reason) {
        const action = !plan.patch ? 'left as is' : plan.patch.inviterId ? `set ${plan.patch.inviterId}` : 'cleared self-inviter';
        ctx.log(
          `${plan.reason === 'climbed' ? 'INFO' : 'WARN'} inviter ${plan.reason}: legacy member=${r.member_id} ` +
            `parent_node=${r.parent_id} legacy_chain=[${legacyChain.join(',')}] → ${action}`,
        );
      }
      if (ctx.dryRun) {
        stats.upserted += 1;
        return;
      }
      if (plan.patch) {
        try {
          // atomic ownership gate: an inviter the app set after the read above wins, and a
          // clear only ever clears the self value it was decided on
          await ctx.prisma.member.updateMany({
            where: {
              id: subjectId,
              OR: [{ inviterSource: null }, { inviterSource: INVITER_SOURCE.LEGACY_PARENT }],
              ...(plan.patch.inviterId === null ? { inviterId: subjectId } : {}),
            },
            data: plan.patch,
          });
        } catch (err) {
          stats.errors += 1;
          wm.failed(toDate(r.wm));
          ctx.log(`ERROR write inviter member_network_id=${r.member_network_id}: ${errCode(err)}`);
          return;
        }
      }
      const base = { affiliateBased: nonEmpty(r.affiliate_based) ?? 'PERFORMANCE' };
      try {
        await ctx.prisma.member.update({ where: { id: subjectId }, data: base });
        // never replaces a code already on the member — a differing one becomes an alias
        const action = await syncLegacyAffiliateCode(ctx.prisma, subjectId, nonEmpty(r.affiliator_code));
        if (action === 'collision') {
          ctx.log(`WARN affiliateCode collision: legacy member=${r.member_id} → code left as is`);
        }
        stats.upserted += 1;
      } catch (err) {
        stats.errors += 1;
        wm.failed(toDate(r.wm));
        ctx.log(`ERROR write tree member_network_id=${r.member_network_id}: ${errCode(err)}`);
      }
    });
  }
}

async function syncInviters(ctx: SyncerCtx, since: Date, stats: Stats, wm: WatermarkTracker): Promise<void> {
  // Only set inviter on ALREADY-migrated members. `member_network` is the GLOBAL affiliate
  // tree (~700k rows for the whole legacy base), NOT a brainboost-scope signal — so we scope
  // the scan to our migrated member_ids (PK-indexed IN) and NEVER create members here
  // (using ensureMember would materialise the entire legacy base). New brainboost members are
  // created by the scoped syncers (enrollments / tree-affiliators / posts / reviews); members
  // materialised AFTER this syncer ran are covered by the end-of-run backfill pass.
  return syncInvitersScoped(ctx, [...ctx.memberByLegacy.keys()], since, stats, wm);
}

/**
 * Program-membership sync. `memberLegacyIds` (backfill mode) narrows the scan to those
 * members' rows; undefined = watermark-driven full scan (the syncer). Rows are folded
 * into `wm` (the syncer's checkpoint; backfill passes none).
 */
export async function syncAffiliatorsScoped(
  ctx: RunCtx & { since: string | null },
  since: Date,
  stats: Stats,
  memberLegacyIds?: number[],
  wm = new WatermarkTracker(),
): Promise<void> {
  // linked brainboost programs: legacy napa_id -> AffiliateProgram.id
  const programByNapa = new Map<number, string>();
  for (const p of await ctx.prisma.affiliateProgram.findMany({
    where: { legacyId: { not: null }, productId: { not: null } },
    select: { id: true, legacyId: true },
  })) {
    if (p.legacyId !== null) programByNapa.set(p.legacyId, p.id);
  }
  const napaIds = [...programByNapa.keys()];
  if (!napaIds.length) return;
  if (memberLegacyIds && !memberLegacyIds.length) return;

  // MemberAffiliator carries both a legacyId unique AND a (memberId,programId) unique —
  // upserting on legacyId can collide on the pair (loser+winner in the same program).
  // Decide update/create/skip in memory so no P2002 is thrown.
  const byPair = new Map<string, { id: string; legacyId: number | null; isActive: boolean }>();
  for (const a of await ctx.prisma.memberAffiliator.findMany({
    select: { id: true, memberId: true, programId: true, legacyId: true, isActive: true },
  })) {
    byPair.set(`${a.memberId}|${a.programId}`, { id: a.id, legacyId: a.legacyId, isActive: a.isActive });
  }

  for (let i = 0; i < napaIds.length; i += 500) {
    const chunk = napaIds.slice(i, i + 500);
    const memberFilter = memberLegacyIds ? ' AND naa.member_id IN (?)' : '';
    const params: unknown[] = memberLegacyIds ? [chunk, since, memberLegacyIds] : [chunk, since];
    const [rows] = await ctx.legacy.query<RowDataPacket[]>(
      `SELECT mpa.member_product_affiliator_id AS mpa_id,
              mpa.network_account_product_affiliator_id AS napa_id,
              naa.member_id AS member_id,
              mpa.status, mpa.exit_state, mpa.exit_date, mpa.deleted, mpa.delete_at,
              COALESCE(mpa.\`updated\`, mpa.\`created\`) AS wm
         FROM member_product_affiliator mpa
         JOIN network_account_affiliator naa
           ON naa.network_account_affiliator_id = mpa.network_account_affiliator_id
        WHERE mpa.network_account_product_affiliator_id IN (?)
          AND COALESCE(mpa.\`updated\`, mpa.\`created\`) > ?${memberFilter}`,
      params,
    );
    // one row per legacy (winner member, program) pair — see prefersAffiliatorRow
    const pairWinner = new Map<string, { legacyId: number; isActive: boolean }>();
    for (const r of rows as any[]) {
      const key = `${ctx.redirect.get(Number(r.member_id)) ?? Number(r.member_id)}|${r.napa_id}`;
      const cand = { legacyId: Number(r.mpa_id), isActive: isLegacyAffiliatorActive(legacyState(r)) };
      const prev = pairWinner.get(key);
      if (!prev || prefersAffiliatorRow(cand, prev)) pairWinner.set(key, cand);
    }
    const applied = new Set([...pairWinner.values()].map((w) => w.legacyId));
    await runConcurrent(rows as any[], resyncConfig.writeConcurrency, async (r: any) => {
      stats.scanned += 1;
      wm.seen(toDate(r.wm));
      if (!applied.has(Number(r.mpa_id))) {
        stats.skipped += 1; // superseded by another legacy row for the same pair
        return;
      }
      const programId = programByNapa.get(Number(r.napa_id));
      const memberId = await ctx.ensureMember(Number(r.member_id));
      if (!programId || !memberId) {
        stats.skipped += 1;
        return;
      }
      const isActive = isLegacyAffiliatorActive(legacyState(r));
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
      // a placeholder = another row's create for this pair is in flight → leave it be
      const write = existing?.id === 'new' ? 'skip' : decideAffiliatorWrite(existing, { legacyId, isActive });
      if (write !== 'skip') byPair.set(pairKey, { id: existing?.id ?? 'new', legacyId, isActive });
      try {
        if (write === 'skip') {
          stats.skipped += 1;
        } else if (existing) {
          // refresh: this row IS the pair's join; repoint: a re-join wrote a newer legacy row
          const data = write === 'repoint' ? { legacyId, ...fields } : fields;
          await ctx.prisma.memberAffiliator.update({ where: { id: existing.id }, data });
          stats.upserted += 1;
        } else {
          await ctx.prisma.memberAffiliator.create({ data: { legacyId, memberId, programId, ...fields } });
          stats.upserted += 1;
        }
      } catch (err: any) {
        if (err?.code === 'P2002' && write !== 'repoint') {
          stats.skipped += 1;
        } else {
          // a re-point colliding on legacyId is a lost re-join, not a duplicate — retry it
          stats.errors += 1;
          wm.failed(toDate(r.wm));
          ctx.log(`ERROR write member_product_affiliator_id=${legacyId} (${write}): ${errCode(err)}`);
        }
      }
    });
  }
}

export const treeSyncer: Syncer = {
  name: 'tree',
  async run(ctx: SyncerCtx): Promise<Stats> {
    const stats = emptyStats();
    const since = sinceBound(ctx.since);
    // one tracker over both tables; the runStart cap keeps the merge safe (a row changed in
    // the first table while the second was scanning is re-scanned next run)
    const wm = new WatermarkTracker();
    await syncInviters(ctx, since, stats, wm);
    await syncAffiliatorsScoped(ctx, since, stats, undefined, wm);
    await ctx.checkpoint(wm.result(ctx.runStart));
    return stats;
  },
};
