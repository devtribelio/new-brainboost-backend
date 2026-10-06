/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Reviews syncer — incremental port of migrate-reviews.ts.
 *
 * SOURCE legacy product_review (status=1, productable_type='TBModel_Course') for migrated
 *        products. The type filter matters: a Bundle/Digital/Book review can share a numeric
 *        productable_id with a migrated Product.legacyId.
 * KEY    no legacyId on Review → upsert on @@unique(productId, memberId).
 * RATING 0 → clamped to 1; outside 1..5 skipped (legacy parity).
 * GAP    Review carries no legacy/app-edit marker, so a re-scan overwrites stars/comment an
 *        app user edited. Needs a provenance column before it can be fixed.
 * See docs/legacy-resync-plan.md §6.
 */
import type { RowDataPacket } from 'mysql2/promise';
import { resyncConfig } from '../config';
import { emptyStats, type Stats, type Syncer, type SyncerCtx } from '../types';
import { errCode, nonEmpty, runConcurrent, sinceBound, toDate, WatermarkTracker } from '../util';

export const reviewsSyncer: Syncer = {
  name: 'reviews',
  async run(ctx: SyncerCtx): Promise<Stats> {
    const stats = emptyStats();
    const since = sinceBound(ctx.since);

    const productByLegacy = new Map<number, string>();
    for (const p of await ctx.prisma.product.findMany({
      where: { legacyId: { not: null } },
      select: { id: true, legacyId: true },
    })) {
      if (p.legacyId !== null) productByLegacy.set(p.legacyId, p.id);
    }
    if (productByLegacy.size === 0) return stats;
    const productLegacyIds = [...productByLegacy.keys()];

    const [rows] = await ctx.legacy.query<RowDataPacket[]>(
      `SELECT product_review_id, productable_id, member_id, rating, note, created,
              COALESCE(\`updated\`, \`created\`) AS wm
         FROM product_review
        WHERE status = 1 AND productable_type = 'TBModel_Course' AND productable_id IN (?)
          AND COALESCE(\`updated\`, \`created\`) > ?
        ORDER BY COALESCE(\`updated\`, \`created\`) ASC, product_review_id ASC`,
      [productLegacyIds, since],
    );
    stats.scanned = (rows as any[]).length;
    if (!stats.scanned) return stats;

    const wm = new WatermarkTracker();
    // upsert key is (product, member) and legacy can hold several rows per pair — rows are
    // ordered wm ASC, so sequentially the newest won. Keep that deterministically under
    // concurrency: dedupe to the last (newest) row per pair BEFORE writing in parallel.
    const byPair = new Map<string, any>();
    for (const r of rows as any[]) {
      wm.seen(toDate(r.wm));
      byPair.set(`${r.productable_id}|${ctx.redirect.get(Number(r.member_id)) ?? Number(r.member_id)}`, r);
    }
    stats.skipped += (rows as any[]).length - byPair.size; // superseded in-batch duplicates

    await runConcurrent([...byPair.values()], resyncConfig.writeConcurrency, async (r: any) => {
      const productId = productByLegacy.get(Number(r.productable_id));
      const memberId = await ctx.ensureMember(Number(r.member_id));
      if (!productId || !memberId) {
        stats.skipped += 1;
        return;
      }
      let stars = Number(r.rating);
      if (stars === 0) stars = 1;
      if (stars < 1 || stars > 5) {
        stats.skipped += 1;
        return;
      }
      if (ctx.dryRun) {
        stats.upserted += 1;
        return;
      }
      const comment = nonEmpty(r.note);
      try {
        await ctx.prisma.review.upsert({
          where: { productId_memberId: { productId, memberId } },
          create: { productId, memberId, stars, comment, createdAt: toDate(r.created) ?? new Date() },
          update: { stars, comment },
        });
        stats.upserted += 1;
      } catch (err) {
        stats.errors += 1;
        wm.failed(toDate(r.wm));
        ctx.log(`ERROR write product_review_id=${r.product_review_id}: ${errCode(err)}`);
      }
    });

    await ctx.checkpoint(wm.result(ctx.runStart));
    return stats;
  },
};
