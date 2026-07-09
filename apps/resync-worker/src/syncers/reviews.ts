/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Reviews syncer — incremental port of migrate-reviews.ts.
 *
 * SOURCE legacy product_review (status=1) for migrated products.
 * KEY    no legacyId on Review → upsert on @@unique(productId, memberId).
 * RATING 0 → clamped to 1; outside 1..5 skipped (legacy parity).
 * See docs/legacy-resync-plan.md §6.
 */
import type { RowDataPacket } from 'mysql2/promise';
import { resyncConfig } from '../config';
import { emptyStats, type Stats, type Syncer, type SyncerCtx } from '../types';
import { maxWatermark, nonEmpty, runConcurrent, sinceBound, toDate } from '../util';

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
        WHERE status = 1 AND productable_id IN (?)
          AND COALESCE(\`updated\`, \`created\`) > ?
        ORDER BY COALESCE(\`updated\`, \`created\`) ASC, product_review_id ASC`,
      [productLegacyIds, since],
    );
    stats.scanned = (rows as any[]).length;
    if (!stats.scanned) return stats;

    let watermark = ctx.since;
    // upsert key is (product, member) and legacy can hold several rows per pair — rows are
    // ordered wm ASC, so sequentially the newest won. Keep that deterministically under
    // concurrency: dedupe to the last (newest) row per pair BEFORE writing in parallel.
    const byPair = new Map<string, any>();
    for (const r of rows as any[]) {
      watermark = maxWatermark(watermark, toDate(r.wm));
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
      } catch {
        stats.errors += 1;
      }
    });

    if (watermark && !ctx.dryRun) await ctx.checkpoint(watermark);
    return stats;
  },
};
