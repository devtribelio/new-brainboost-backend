/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * DECIDED 2026-10-06: option C (keputusan P0-1). Runs right AFTER `treeSyncer` in ./index.ts:
 * the tree pass writes LEGACY_PARENT first, this pass then overrides it, and the tree never
 * overwrites LEGACY_CONNECT back (inviter-rules.ts mayOverwriteInviter).
 *
 * Connect syncer — legacy member_network_connect → members.inviter_id / inviter_source.
 *
 * SOURCE member_network_connect (insert-once; status=0 = removed by a legacy admin),
 *        watermark COALESCE(updated, created). ~5k rows → one query.
 * SCOPE  subject must already be migrated (resolveMember via redirect; never created here);
 *        the connect affiliator is ensureMember'd (a connected affiliator of a brainboost
 *        buyer is in scope by definition).
 * DECIDE decideConnectWrite (./connect-rules.ts) given the resolved legacy parent, the
 *        subject's legacy downlines (variant C only) and the cycle guard.
 * WRITE  atomic updateMany gated on inviterSource IN (NULL, LEGACY_PARENT, LEGACY_CONNECT)
 *        — an APP inviter set after the read wins; a clear only clears the value decided on.
 *
 * Gap: a member materialised on demand AFTER this syncer ran gets its connect only when
 * the legacy row is next touched (backfill pass does not cover connect) — or force a pass
 * with `--since=1970-01-01T00:00:00Z` (the whole table is ~5k rows).
 */
import type { RowDataPacket } from 'mysql2/promise';
import { resyncConfig } from '../config';
import { emptyStats, type RunCtx, type Stats, type Syncer, type SyncerCtx } from '../types';
import { errCode, runConcurrent, sinceBound, toDate, WatermarkTracker } from '../util';
import { decideConnectWrite, type ConnectVariant } from './connect-rules';
import { CYCLE_CHECK_LEVELS, INVITER_SOURCE, MAX_CLIMB_HOPS, chainHitsSubject, pickInviter } from './inviter-rules';

/**
 * P0-1 decision (2026-10-06): 'C' — connect wins, except a member with downlines whose connect
 * differs from its legacy parent keeps the parent, so L2–L4 of its downlines stay exactly as
 * legacy pays them ('A' = connect always wins; kept only so the rule is spelled out in tests).
 */
export const CONNECT_VARIANT: ConnectVariant = 'C';

const CHUNK = 5000;

interface LegacyNode {
  memberId: number | null;
  parentId: number | null;
}

async function fetchNodes(ctx: RunCtx, nodeIds: number[]): Promise<Map<number, LegacyNode>> {
  const map = new Map<number, LegacyNode>();
  for (let i = 0; i < nodeIds.length; i += CHUNK) {
    const chunk = nodeIds.slice(i, i + CHUNK);
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

/** subject legacy id → its newest member_network parent node (same row choice as the tree pass). */
async function fetchParentNodes(ctx: RunCtx, legacyIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, { parent: number; wm: number }>();
  for (let i = 0; i < legacyIds.length; i += CHUNK) {
    const [rows] = await ctx.legacy.query<RowDataPacket[]>(
      `SELECT member_id, parent_id, COALESCE(\`updated\`, \`created\`) AS wm
         FROM member_network WHERE member_id IN (?) AND parent_id IS NOT NULL`,
      [legacyIds.slice(i, i + CHUNK)],
    );
    for (const r of rows as any[]) {
      const id = Number(r.member_id);
      const wm = toDate(r.wm)?.getTime() ?? 0;
      const prev = out.get(id);
      if (!prev || wm >= prev.wm) out.set(id, { parent: Number(r.parent_id), wm });
    }
  }
  return new Map([...out].map(([id, v]) => [id, v.parent]));
}

/** Legacy member ids (any alias) whose member_network node has at least one child. */
async function fetchMembersWithDownlines(ctx: RunCtx, legacyIds: number[]): Promise<Set<number>> {
  const out = new Set<number>();
  for (let i = 0; i < legacyIds.length; i += CHUNK) {
    const [rows] = await ctx.legacy.query<RowDataPacket[]>(
      `SELECT DISTINCT p.member_id
         FROM member_network p JOIN member_network c ON c.parent_id = p.member_network_id
        WHERE p.member_id IN (?)`,
      [legacyIds.slice(i, i + CHUNK)],
    );
    for (const r of rows as any[]) out.add(Number(r.member_id));
  }
  return out;
}

/** Resolve a parent node to an inviter, climbing past nodes that resolve to the subject. */
async function resolveParent(
  ctx: RunCtx,
  subjectId: string,
  parentNodeId: number | undefined,
  nodes: Map<number, LegacyNode>,
): Promise<string | null> {
  const ancestors: Array<string | undefined> = [];
  let nodeId: number | null = parentNodeId ?? null;
  for (let hop = 0; hop <= MAX_CLIMB_HOPS && nodeId != null; hop += 1) {
    const node: LegacyNode | undefined = nodes.get(nodeId) ?? (await fetchNodes(ctx, [nodeId])).get(nodeId);
    const memberId = node?.memberId != null ? ctx.resolveMember(node.memberId) : undefined;
    ancestors.push(memberId);
    if (memberId !== subjectId) break;
    nodeId = node?.parentId ?? null;
  }
  const pick = pickInviter(subjectId, ancestors);
  return pick.status === 'ok' ? pick.inviterId : null;
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

/** One row per subject: the subject's own legacy row beats an alias's, then newest wins. */
function pickRowPerSubject(ctx: RunCtx, rows: any[]): Map<string, any> {
  const best = new Map<string, any>();
  const rank = (r: any) => [ctx.redirect.has(Number(r.member_id)) ? 0 : 1, toDate(r.wm)?.getTime() ?? 0];
  for (const r of rows) {
    const subjectId = ctx.resolveMember(Number(r.member_id));
    if (!subjectId) continue;
    const prev = best.get(subjectId);
    const [a1, a2] = rank(r);
    const [b1, b2] = prev ? rank(prev) : [-1, -1];
    if (!prev || a1 > b1 || (a1 === b1 && a2 >= b2)) best.set(subjectId, r);
  }
  return best;
}

export const connectSyncer: Syncer = {
  name: 'connect',
  async run(ctx: SyncerCtx): Promise<Stats> {
    const stats = emptyStats();
    const since = sinceBound(ctx.since);
    const wm = new WatermarkTracker();

    const [rows] = await ctx.legacy.query<RowDataPacket[]>(
      `SELECT member_network_connect_id, member_id, affiliator_member_id, status,
              COALESCE(\`updated\`, \`created\`) AS wm
         FROM member_network_connect
        WHERE member_id IS NOT NULL AND COALESCE(\`updated\`, \`created\`) > ?
        ORDER BY COALESCE(\`updated\`, \`created\`) ASC, member_network_connect_id ASC`,
      [since],
    );
    stats.scanned = (rows as any[]).length;
    for (const r of rows as any[]) wm.seen(toDate(r.wm));
    const bySubject = pickRowPerSubject(ctx, rows as any[]);
    stats.skipped += stats.scanned - bySubject.size; // not migrated, or superseded alias row

    const subjectIds = [...bySubject.keys()];
    const current = new Map<string, { inviterId: string | null; inviterSource: string | null }>();
    for (let i = 0; i < subjectIds.length; i += CHUNK) {
      for (const m of await ctx.prisma.member.findMany({
        where: { id: { in: subjectIds.slice(i, i + CHUNK) } },
        select: { id: true, inviterId: true, inviterSource: true },
      })) {
        current.set(m.id, { inviterId: m.inviterId, inviterSource: m.inviterSource });
      }
    }

    // legacy parent of each subject = its WINNER legacy id's member_network row (as the tree)
    const winnerLegacy = new Map<string, number>();
    for (const [legacyId, uuid] of ctx.memberByLegacy) if (bySubject.has(uuid)) winnerLegacy.set(uuid, legacyId);
    const parentNodeOf = await fetchParentNodes(ctx, [...winnerLegacy.values()]);
    const nodes = await fetchNodes(ctx, [...new Set(parentNodeOf.values())]);

    // downlines: children under ANY legacy alias of the subject (variant C only)
    const subjectsWithDownlines = new Set<string>();
    if (CONNECT_VARIANT === 'C') {
      const aliasIds = [...ctx.redirect]
        .filter(([, winner]) => bySubject.has(ctx.memberByLegacy.get(winner) ?? ''))
        .map(([loser]) => loser);
      for (const legacyId of await fetchMembersWithDownlines(ctx, [...winnerLegacy.values(), ...aliasIds])) {
        const uuid = ctx.resolveMember(legacyId);
        if (uuid) subjectsWithDownlines.add(uuid);
      }
    }

    await runConcurrent([...bySubject], resyncConfig.writeConcurrency, async ([subjectId, r]) => {
      const cur = current.get(subjectId);
      if (!cur) {
        stats.skipped += 1;
        return;
      }
      try {
        const connectActive = Number(r.status) === 1;
        // a removed connect only needs the id for comparison — never materialise for it
        const affiliatorLegacyId = r.affiliator_member_id != null ? Number(r.affiliator_member_id) : null;
        const affiliatorId = connectActive
          ? await ctx.ensureMember(affiliatorLegacyId)
          : ctx.resolveMember(affiliatorLegacyId);
        const legacyId = winnerLegacy.get(subjectId);
        const parentId =
          legacyId !== undefined ? await resolveParent(ctx, subjectId, parentNodeOf.get(legacyId), nodes) : null;
        const reverting = (!connectActive || affiliatorId === subjectId) && cur.inviterSource === INVITER_SOURCE.LEGACY_CONNECT;
        const connectCandidate = connectActive && affiliatorId && affiliatorId !== subjectId && affiliatorId !== cur.inviterId;
        const plan = decideConnectWrite(
          {
            subjectId,
            current: cur,
            connectActive,
            affiliatorId,
            parentId,
            hasDownlines: subjectsWithDownlines.has(subjectId),
            connectClosesCycle: connectCandidate ? await wouldCloseCycle(ctx, subjectId, affiliatorId) : false,
            parentClosesCycle: reverting && parentId ? await wouldCloseCycle(ctx, subjectId, parentId) : false,
          },
          CONNECT_VARIANT,
        );
        if (plan.reason) {
          const warn = ['cycle', 'downlines', 'unresolved', 'revert-kept'].includes(plan.reason);
          const action = !plan.patch ? 'left as is' : plan.patch.inviterId ? `set ${plan.patch.inviterId}` : 'cleared';
          ctx.log(
            `${warn ? 'WARN' : 'INFO'} connect ${plan.reason}: legacy member=${r.member_id} ` +
              `affiliator=${r.affiliator_member_id} status=${r.status} variant=${CONNECT_VARIANT} → ${action}`,
          );
        }
        if (!plan.patch) {
          stats.skipped += 1;
          return;
        }
        if (ctx.dryRun) {
          stats.upserted += 1;
          return;
        }
        await ctx.prisma.member.updateMany({
          where: {
            id: subjectId,
            OR: [
              { inviterSource: null },
              { inviterSource: INVITER_SOURCE.LEGACY_PARENT },
              { inviterSource: INVITER_SOURCE.LEGACY_CONNECT },
            ],
            ...(plan.patch.inviterId === null ? { inviterId: cur.inviterId } : {}),
          },
          data: plan.patch,
        });
        stats.upserted += 1;
      } catch (err) {
        stats.errors += 1;
        wm.failed(toDate(r.wm));
        ctx.log(`ERROR write member_network_connect_id=${r.member_network_connect_id}: ${errCode(err)}`);
      }
    });

    await ctx.checkpoint(wm.result(ctx.runStart));
    return stats;
  },
};
