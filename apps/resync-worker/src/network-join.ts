/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Community auto-join for members materialised on demand by `ensureMember`.
 *
 * BrainBoost has exactly two community networks (purpose `timeline` + `education`) and
 * EVERY member belongs to both — it is mandatory, not derived from legacy membership
 * (same rule as the one-shot `scripts/migrate-network-members.ts`). The app enforces it
 * on registration via `AuthService.autoJoinCommunityNetworks`, but a member created by
 * resync never passes through that path, so without this pass they end up with no
 * `NetworkMember` row at all: `/network` (my networks) comes back empty, the notification
 * fan-out skips them, and every write path (post / comment / like) 403s with
 * NETWORK_MEMBERSHIP_REQUIRED — reading the feed still works only because both networks
 * are public.
 *
 * Idempotent: `createMany({ skipDuplicates })` against the `@@unique([networkId, memberId])`
 * index, so an adopted app placeholder that already joined at registration is a no-op and
 * `count_member` is never double-bumped. The increment mirrors the app's own bookkeeping;
 * `recountCounters` rebuilds the column from the table afterwards anyway.
 *
 * NOTE: this only covers members created/adopted from THIS run onwards. Members that
 * resync materialised BEFORE this pass existed need the one-shot backfill SQL (see
 * docs/legacy-resync-plan.md).
 */
import type { RunCtx, Stats } from './types';

/** `networks.purpose` values that every member is auto-joined to. */
const COMMUNITY_PURPOSES = ['timeline', 'education'];
const INSERT_CHUNK = 5000;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Join the given (just-materialised) legacy member ids to both community networks.
 * Accumulates into the caller's Stats; per-network failures are isolated.
 */
export async function joinCommunityNetworks(
  ctx: RunCtx,
  legacyIds: number[],
  stats: Stats,
): Promise<void> {
  const memberIds = [
    ...new Set(
      legacyIds
        .map((id) => ctx.resolveMember(id))
        .filter((id): id is string => id !== undefined),
    ),
  ];
  if (!memberIds.length) return;

  const networks = await ctx.prisma.network.findMany({
    where: { purpose: { in: COMMUNITY_PURPOSES }, isActive: true },
    select: { id: true, code: true },
  });
  if (!networks.length) {
    ctx.log('WARN: no active community network (purpose timeline/education) — skipping auto-join');
    return;
  }

  // joinedAt mirrors the member's own createdAt (same rule as migrate-network-members.ts)
  const joinedAt = new Map<string, Date>();
  for (const m of await ctx.prisma.member.findMany({
    where: { id: { in: memberIds } },
    select: { id: true, createdAt: true },
  })) {
    joinedAt.set(m.id, m.createdAt);
  }

  for (const n of networks) {
    let inserted = 0;
    try {
      for (const ids of chunk(memberIds, INSERT_CHUNK)) {
        const res = await ctx.prisma.networkMember.createMany({
          data: ids.map((memberId) => ({
            networkId: n.id,
            memberId,
            joinedAt: joinedAt.get(memberId) ?? new Date(),
          })),
          skipDuplicates: true,
        });
        inserted += res.count;
      }
      if (inserted) {
        await ctx.prisma.network.update({
          where: { id: n.id },
          data: { countMember: { increment: inserted } },
        });
      }
      stats.scanned += memberIds.length;
      stats.upserted += inserted;
      stats.skipped += memberIds.length - inserted; // already a member
    } catch (err: any) {
      stats.errors += 1;
      ctx.log(`ERROR auto-join ${n.code ?? n.id}: ${err?.message ?? err}`);
    }
  }
}
