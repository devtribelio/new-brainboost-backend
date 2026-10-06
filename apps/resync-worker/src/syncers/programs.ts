/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Programs syncer — incremental port of migrate-from-legacy.ts::migrateAffiliatePrograms
 * + scripts/backfill-affiliate-program-product.ts (PRD P1 #11).
 *
 * Programs were created ONCE by the migration, so a brainboost course created in legacy
 * afterwards (e.g. course 7622 "Action Booster") never got an AffiliateProgram here — and
 * the tree pass only syncs member_product_affiliator rows of LINKED programs, so its
 * joiners were silently dropped. Runs BEFORE tree for that reason.
 *
 * SOURCE network_account_product_affiliator (napa), productable = TBModel_Course, for
 *        in-scope brainboost courses (BB_COURSE_IDS_SQL), watermark COALESCE(updated, created).
 * KEY    AffiliateProgram.legacyId = napa id. Same shape as the two scripts:
 *        code `PROG-<napaId>`, name = napa.name, productId = the course's Product,
 *        isActive = true (legacy is_active is 0 for every course program; the backfill
 *        turned brainboost affiliate ON for every linked one).
 * WRITES create a missing program; link (productId + isActive=true, the backfill's rule) an
 *        existing one that still has productId NULL. Never touches a program that is already
 *        linked (no rename, re-point or re-activation) — those belong to the app/backoffice. A legacy-removed napa (status≠1 / deleted) is
 *        skipped, as the migration filtered it.
 * NEVER  creates products/courses (catalog is out of scope) — an in-scope course with a
 *        program but no PG product is logged.
 */
import type { RowDataPacket } from 'mysql2/promise';
import { emptyStats, type Stats, type Syncer, type SyncerCtx } from '../types';
import { errCode, markReason, markSkip, nonEmpty, sinceBound, toDate, WatermarkTracker } from '../util';
import { BB_COURSE_IDS_SQL } from './enrollments';

export const programsSyncer: Syncer = {
  name: 'programs',
  async run(ctx: SyncerCtx): Promise<Stats> {
    const stats = emptyStats();
    const since = sinceBound(ctx.since);

    const [scopeRows] = await ctx.legacy.query<RowDataPacket[]>(BB_COURSE_IDS_SQL);
    const scopeCourseIds = (scopeRows as any[]).map((r) => Number(r.course_id));
    if (!scopeCourseIds.length) return stats;

    const [rows] = await ctx.legacy.query<RowDataPacket[]>(
      `SELECT network_account_product_affiliator_id AS napa_id, productable_id AS course_id,
              name, status, deleted, created, COALESCE(\`updated\`, \`created\`) AS wm
         FROM network_account_product_affiliator
        WHERE productable LIKE '%Course%' AND productable_id IN (?)
          AND COALESCE(\`updated\`, \`created\`) > ?
        ORDER BY COALESCE(\`updated\`, \`created\`) ASC, network_account_product_affiliator_id ASC`,
      [scopeCourseIds, since],
    );
    stats.scanned = (rows as any[]).length;
    if (!stats.scanned) return stats;

    // legacy course_id -> Product.id (via Course.legacyCourseId — covers mini courses too)
    const productByCourse = new Map<number, string>();
    for (const c of await ctx.prisma.course.findMany({
      where: { legacyCourseId: { not: null } },
      select: { productId: true, legacyCourseId: true },
    })) {
      if (c.legacyCourseId !== null) productByCourse.set(c.legacyCourseId, c.productId);
    }
    const existing = new Map<number, { id: string; productId: string | null }>();
    for (const p of await ctx.prisma.affiliateProgram.findMany({
      where: { legacyId: { in: (rows as any[]).map((r) => Number(r.napa_id)) } },
      select: { id: true, legacyId: true, productId: true },
    })) {
      if (p.legacyId !== null) existing.set(p.legacyId, { id: p.id, productId: p.productId });
    }

    const wm = new WatermarkTracker();
    const noProduct = new Set<number>();
    let linked = 0; // created, or an unlinked one given its product
    // sequential: a few rows per run, and two napa rows can never collide (keyed by napa id)
    for (const r of rows as any[]) {
      wm.seen(toDate(r.wm));
      const legacyId = Number(r.napa_id);
      const productId = productByCourse.get(Number(r.course_id));
      const prev = existing.get(legacyId);
      if (Number(r.status) !== 1 || r.deleted != null || !productId || prev?.productId) {
        if (!productId) {
          noProduct.add(Number(r.course_id));
          markSkip(stats, 'program_course_not_mapped', r.napa_id);
        } else if (prev?.productId) {
          markReason(stats, 'program_already_linked', r.napa_id);
        } else {
          markReason(stats, 'program_inactive_or_deleted', r.napa_id);
        }
        continue;
      }
      if (ctx.dryRun) {
        stats.upserted += 1;
        continue;
      }
      try {
        if (prev) {
          await ctx.prisma.affiliateProgram.update({ where: { id: prev.id }, data: { productId, isActive: true } });
        } else {
          await ctx.prisma.affiliateProgram.create({
            data: {
              legacyId,
              productId,
              code: `PROG-${legacyId}`,
              name: nonEmpty(r.name) ?? `Program ${legacyId}`,
              isActive: true,
              createdAt: toDate(r.created) ?? new Date(),
            },
          });
        }
        linked += 1;
        stats.upserted += 1;
      } catch (err: any) {
        if (err?.code === 'P2002') {
          // e.g. code PROG-<id> already held by a program without this legacyId: retrying every
          // run can't fix it — settle the row and leave it for a human
          markSkip(stats, 'unique_clash', legacyId);
          void ctx.recordIssue('program_unique_clash', legacyId, 'PROG-<id> code or name collision');
          ctx.log(`WARN program napa=${legacyId} collides on a unique field — left for review`);
        } else {
          stats.errors += 1;
          wm.failed(toDate(r.wm));
          ctx.log(`ERROR write network_account_product_affiliator_id=${legacyId}: ${errCode(err)}`);
        }
      }
    }
    if (noProduct.size) {
      ctx.log(`in-scope legacy courses with a program but no PG product: ${[...noProduct].join(', ')}`);
    }

    if (linked) {
      // joins of a newly linked program predate the tree watermark → they never ride it
      ctx.log(
        `WARN ${linked} program(s) newly linked — pull their existing joiners once with ` +
          '`pnpm resync tree --since=1970-01-01T00:00:00Z` (dry-run first)',
      );
    }

    await ctx.checkpoint(wm.result(ctx.runStart));
    return stats;
  },
};
