import { prisma } from '@/config/prisma';
import { GROWTH_MAX_DEPTH, AFFILIATE_BASED } from '../constants';

export interface InviterChainNode {
  id: string;
  affiliateBased: string;
  inviterId: string | null;
  level: number;
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

  const rows = await prisma.$queryRaw<Array<{ id: string; affiliateBased: string; inviterId: string | null; level: number }>>`
    WITH RECURSIVE chain AS (
      SELECT id, "affiliateBased", "inviterId", 1 AS level
      FROM members
      WHERE id = ${startMemberId}::uuid
      UNION ALL
      SELECT m.id, m."affiliateBased", m."inviterId", c.level + 1
      FROM members m
      INNER JOIN chain c ON m.id = c."inviterId"
      WHERE c.level < ${maxDepth}
    )
    SELECT id, "affiliateBased", "inviterId", level FROM chain ORDER BY level ASC
  `;

  if (!stopOnPerformance) return rows;

  const cutIdx = rows.findIndex((r, i) => i > 0 && r.affiliateBased === AFFILIATE_BASED.PERFORMANCE);
  return cutIdx === -1 ? rows : rows.slice(0, cutIdx);
}
