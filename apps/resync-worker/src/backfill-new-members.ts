/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * End-of-run backfill for members materialised on demand THIS run (ensureMember create
 * or adopt). Their pre-existing legacy rows in OTHER tables carry `updated` values that
 * already fell behind those syncers' watermarks, so the regular incremental scans will
 * never revisit them — without this pass a member who enters brainboost scope after the
 * first full run would permanently miss:
 *
 *   - their legacy KYC decision            (member_data_kyc rows are old)
 *   - inviter chain + program memberships  (member_network / member_product_affiliator)
 *   - old commissions they received        (affiliator_commision, incl. non-BB rows that
 *                                           count toward lifetime tier)
 *   - old post/comment likes they gave     (like rows are old)
 *
 * All lookups are IN-list scoped to just the new legacy ids (typically 0–tens per tick)
 * with since=epoch, and every write path is the same idempotent helper the syncers use.
 * Enrollments/posts/reviews need no backfill — those rows DRIVE member creation.
 */
import type { RowDataPacket } from 'mysql2/promise';
import { resyncConfig } from './config';
import { applyKycDecisions } from './syncers/kyc';
import { syncInvitersScoped, syncAffiliatorsScoped } from './syncers/tree';
import { applyCommissionRow, buildCommissionMaps, COMMISSION_COLS } from './syncers/commissions';
import { emptyStats, type RunCtx, type Stats } from './types';
import { runConcurrent, toDate } from './util';

const EPOCH = new Date(0);
const IN_CHUNK = 1000;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function backfillCommissions(ctx: RunCtx, newIds: number[], stats: Stats): Promise<void> {
  const maps = await buildCommissionMaps(ctx);
  for (const ids of chunk(newIds, IN_CHUNK)) {
    const [rows] = await ctx.legacy.query<RowDataPacket[]>(
      `SELECT ${COMMISSION_COLS} FROM affiliator_commision WHERE member_recipient_id IN (?)`,
      [ids],
    );
    await runConcurrent(rows as any[], resyncConfig.writeConcurrency, async (r: any) => {
      stats.scanned += 1;
      await applyCommissionRow(ctx, r, maps, stats);
    });
  }
}

async function backfillLikes(ctx: RunCtx, newIds: number[], stats: Stats): Promise<void> {
  // maps of ALL migrated posts/comments (legacyId -> uuid) to scope the like rows
  const postMap = new Map<number, string>();
  for (const p of await ctx.prisma.post.findMany({ where: { legacyId: { not: null } }, select: { id: true, legacyId: true } })) {
    postMap.set(p.legacyId as number, p.id);
  }
  const commentMap = new Map<number, string>();
  for (const c of await ctx.prisma.comment.findMany({ where: { legacyId: { not: null } }, select: { id: true, legacyId: true } })) {
    commentMap.set(c.legacyId as number, c.id);
  }

  for (const ids of chunk(newIds, IN_CHUNK)) {
    const [rows] = await ctx.legacy.query<RowDataPacket[]>(
      `SELECT post_id, comment_id, member_id, created FROM \`like\`
        WHERE status=1 AND member_id IN (?)`,
      [ids],
    );
    const postLikes: any[] = [];
    const commentLikes: any[] = [];
    for (const r of rows as any[]) {
      stats.scanned += 1;
      const memberId = ctx.resolveMember(Number(r.member_id));
      if (!memberId) {
        stats.skipped += 1;
        continue;
      }
      const isComment = r.comment_id != null && Number(r.comment_id) !== 0;
      const targetId = isComment ? commentMap.get(Number(r.comment_id)) : postMap.get(Number(r.post_id));
      if (!targetId) {
        stats.skipped += 1; // like on a non-BB (or hard-deleted) post/comment
        continue;
      }
      const row = { memberId, createdAt: toDate(r.created) ?? new Date() };
      if (isComment) commentLikes.push({ commentId: targetId, ...row });
      else postLikes.push({ postId: targetId, ...row });
    }
    if (postLikes.length) {
      stats.upserted += (await ctx.prisma.postLike.createMany({ data: postLikes, skipDuplicates: true })).count;
    }
    if (commentLikes.length) {
      stats.upserted += (await ctx.prisma.commentLike.createMany({ data: commentLikes, skipDuplicates: true })).count;
    }
  }
}

/**
 * Run the backfill for the given just-created legacy member ids. Returns its own Stats
 * (surfaced as the `backfill` entry of the run results). Never runs in dry-run — a dry
 * run's ensureMember is a pure lookup and creates nobody.
 */
export async function backfillNewMembers(ctx: RunCtx, newIds: number[]): Promise<Stats> {
  const stats = emptyStats();

  // widen to dedup losers — legacy rows may reference a loser id of a just-created winner;
  // resolveMember/ensureMember redirect them back to the winner at apply time.
  const withLosers = new Set(newIds);
  for (const [loser, winner] of ctx.redirect) if (withLosers.has(winner)) withLosers.add(loser);
  const wide = [...withLosers];

  await applyKycDecisions(ctx, newIds, stats); // cluster-widens internally
  const scoped = { ...ctx, since: null as string | null };
  // inviter chain stays winner-scoped: a loser's member_network row must never set a
  // winner's inviter (same rule as the tree syncer)
  await syncInvitersScoped(scoped, newIds, EPOCH, stats);
  await syncAffiliatorsScoped(scoped, EPOCH, stats, wide);
  await backfillCommissions(ctx, wide, stats);
  await backfillLikes(ctx, wide, stats);
  return stats;
}
