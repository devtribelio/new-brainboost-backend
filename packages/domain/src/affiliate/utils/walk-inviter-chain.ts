import { prisma } from '@bb/db';
import { GROWTH_MAX_DEPTH, AFFILIATE_BASED } from '../constants';

export interface InviterChainNode {
  id: string;
  affiliateBased: string;
  inviterId: string | null;
  level: number;
  /**
   * Set when this member's account has been soft-deleted. The node stays IN the
   * chain — dropping it here would shift everyone above it up a level and quietly
   * change their rate (L2 10% → L1 20%). Payouts must not move because a third
   * party closed their account, so the caller skips paying this node and leaves
   * every other level exactly where it was.
   */
  deletedAt: Date | null;
}

/**
 * Cut a level-ordered chain at the first repeated member id.
 *
 * The recursive CTE below uses `UNION ALL` with no cycle detection, so a mutual
 * inviter link (A→B→A→B…) yields the SAME member at multiple levels. Without
 * this guard the commission loop would pay one colluder at level 1 AND level 3
 * (the unique constraint is per-level, so it does not block the duplicate), and
 * a buyer could earn on their own purchase. Cutting at the first repeat bounds
 * cycles and guarantees each member appears at most once. Pure — unit-tested.
 */
export function cutChainCycles<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) break;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

/**
 * Walk parent chain via Member.inviterId, max N levels.
 * Mirror legacy TBModel_MemberNetwork::getParentTree.
 *
 * Optionally `stopOnPerformance` — kalau true, chain berhenti dini saat
 * encounter affiliator berstatus PERFORMANCE (legacy behavior di GROWTH path
 * di TBAffiliator_Commision_CoursePayment::buildArrayRecipientMultitier).
 *
 * Pakai recursive CTE Postgres — 1 query, jauh lebih cepat dari N round-trip.
 */
export async function walkInviterChain(
  startMemberId: string,
  options: { maxDepth?: number; stopOnPerformance?: boolean } = {},
): Promise<InviterChainNode[]> {
  const maxDepth = options.maxDepth ?? GROWTH_MAX_DEPTH;
  const stopOnPerformance = options.stopOnPerformance ?? false;

  const rows = await prisma.$queryRaw<Array<{ id: string; affiliateBased: string; inviterId: string | null; level: number; deletedAt: Date | null }>>`
    WITH RECURSIVE chain AS (
      SELECT id, affiliate_based AS "affiliateBased", inviter_id AS "inviterId", 1 AS level,
             deleted_at AS "deletedAt"
      FROM members
      WHERE id = ${startMemberId}::uuid
      UNION ALL
      SELECT m.id, m.affiliate_based, m.inviter_id, c.level + 1, m.deleted_at
      FROM members m
      INNER JOIN chain c ON m.id = c."inviterId"
      WHERE c.level < ${maxDepth}
    )
    SELECT id, "affiliateBased", "inviterId", level, "deletedAt" FROM chain ORDER BY level ASC
  `;

  // Always guard against cycles first (mutual A<->B inviter links).
  const chain = cutChainCycles(rows);

  if (!stopOnPerformance) return chain;

  const cutIdx = chain.findIndex((r, i) => i > 0 && r.affiliateBased === AFFILIATE_BASED.PERFORMANCE);
  return cutIdx === -1 ? chain : chain.slice(0, cutIdx);
}
