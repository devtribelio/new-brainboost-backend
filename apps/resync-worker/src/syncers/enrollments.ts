/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Enrollments syncer — incremental port of migrate-members.ts::migrateEnrollments.
 *
 * SOURCE legacy course_enrollment (brainboost courses only) + payment status.
 * ACCESS course_payment SUCCESS OR bundle_payment SUCCESS OR both null (free).
 * KEY    legacyId = course_enrollment_id; also @@unique(memberId, courseId).
 * No new-system conflict — new purchases create their own rows with legacyId=null.
 * DELETE legacy `status = 0` -> isCanceled (see below).
 * See docs/legacy-resync-plan.md §6.
 */
import type { RowDataPacket } from 'mysql2/promise';
import { resyncConfig } from '../config';
import { emptyStats, type Stats, type Syncer, type SyncerCtx } from '../types';
import { maxWatermark, nonEmpty, runConcurrent, sinceBound, toDate } from '../util';

const BB_COURSES = `course_id IN (SELECT course_id FROM course WHERE client = 'brainboost')`;

/** Stamped on rows cancelled because legacy removed them, so support can tell them apart from a refund. */
const LEGACY_CANCEL_REASON = 'legacy_removed';

export const enrollmentsSyncer: Syncer = {
  name: 'enrollments',
  async run(ctx: SyncerCtx): Promise<Stats> {
    const stats = emptyStats();
    const since = sinceBound(ctx.since);

    // legacy course_id -> new Course.id
    const courseByLegacy = new Map<number, string>();
    for (const c of await ctx.prisma.course.findMany({
      where: { legacyCourseId: { not: null } },
      select: { id: true, legacyCourseId: true },
    })) {
      if (c.legacyCourseId !== null) courseByLegacy.set(c.legacyCourseId, c.id);
    }

    const [rows] = await ctx.legacy.query<RowDataPacket[]>(
      `SELECT e.course_enrollment_id, e.member_id, e.course_id, e.created, e.expired_date,
              e.certificate_code, e.certificate_created, e.progress, e.status,
              COALESCE(e.\`updated\`, e.\`created\`) AS wm,
              cp.payment_status AS course_ps, bp.payment_status AS bundle_ps
         FROM course_enrollment e
         LEFT JOIN course_payment cp ON cp.course_payment_id = e.course_payment_id
         LEFT JOIN product_bundle_payment_detail bd
                ON bd.product_bundle_payment_detail_id = e.product_bundle_payment_detail_id
         LEFT JOIN product_bundle_payment bp ON bp.product_bundle_payment_id = bd.product_bundle_payment_id
        WHERE e.${BB_COURSES} AND e.member_id IS NOT NULL
          AND COALESCE(e.\`updated\`, e.\`created\`) > ?
        ORDER BY COALESCE(e.\`updated\`, e.\`created\`) ASC, e.course_enrollment_id ASC`,
      [since],
    );
    stats.scanned = (rows as any[]).length;
    if (!stats.scanned) return stats;

    // Preload existing enrollments keyed by (memberId,courseId). The enrollment carries
    // BOTH a legacyId unique AND a (memberId,courseId) unique — upserting on legacyId can
    // collide on the pair (e.g. a loser+winner enrolled in the same course, or a member
    // who bought the same course twice). Decide update/create/skip in memory so no P2002
    // is ever thrown, and never clobber a new-system enrollment's progress (legacyId=null).
    const byPair = new Map<string, { id: string; legacyId: number | null }>();
    for (const e of await ctx.prisma.courseEnrollment.findMany({
      select: { id: true, memberId: true, courseId: true, legacyId: true },
    })) {
      byPair.set(`${e.memberId}|${e.courseId}`, { id: e.id, legacyId: e.legacyId });
    }

    let watermark = ctx.since;
    await runConcurrent(rows as any[], resyncConfig.writeConcurrency, async (r: any) => {
      watermark = maxWatermark(watermark, toDate(r.wm));
      const legacyId = Number(r.course_enrollment_id);

      // Legacy removal. `course_enrollment` has NO `deleted` column, so the Cresenity
      // soft-delete writes `status = 0` (and bumps `updated`, which is what rides the
      // row into this scan). Two things reach it: the free-trial expiry cron
      // (TBTaskQueue_Payment_Product_CourseEnrollmentExpiredFreeTrial, every minute)
      // and a manual removal. Before this branch existed both came back as LIVE
      // enrollments here — 3 507 of them at the time of writing.
      //
      // Handled ahead of the payment/access check on purpose: a removal is true
      // regardless of what the payment row says now.
      if (Number(r.status) === 0) {
        await cancelRemoved(ctx, stats, byPair, r, legacyId, courseByLegacy);
        return;
      }

      const access =
        r.course_ps === 'SUCCESS' || r.bundle_ps === 'SUCCESS' || (r.course_ps == null && r.bundle_ps == null);
      if (!access) {
        stats.skipped += 1;
        return;
      }
      const memberId = await ctx.ensureMember(Number(r.member_id));
      const courseId = courseByLegacy.get(Number(r.course_id));
      if (!memberId || !courseId) {
        stats.skipped += 1;
        return;
      }
      const pairKey = `${memberId}|${courseId}`;

      if (ctx.dryRun) {
        stats.upserted += 1;
        return;
      }
      // read-decide-claim synchronously (no await between get and set) so a concurrent
      // row for the same pair sees the claim and takes the skip path, not a create race.
      const existing = byPair.get(pairKey);
      if (!existing) byPair.set(pairKey, { id: 'new', legacyId }); // dedup further in-run rows for this pair
      try {
        if (existing) {
          // Member already has access. Only refresh mutable fields when this row IS that
          // enrollment (same legacyId); otherwise skip — don't fight over the pair or
          // overwrite a new-system row's progress with stale legacy data.
          if (existing.legacyId === legacyId) {
            await ctx.prisma.courseEnrollment.update({
              where: { id: existing.id },
              data: {
                expiredDate: toDate(r.expired_date),
                certificateCode: nonEmpty(r.certificate_code),
                certificateCreated: toDate(r.certificate_created),
                progress: Number(r.progress ?? 0) || 0,
              },
            });
            stats.upserted += 1;
          } else {
            stats.skipped += 1;
          }
        } else {
          await ctx.prisma.courseEnrollment.create({
            data: {
              legacyId,
              memberId,
              courseId,
              dateStart: toDate(r.created),
              expiredDate: toDate(r.expired_date),
              certificateCode: nonEmpty(r.certificate_code),
              certificateCreated: toDate(r.certificate_created),
              progress: Number(r.progress ?? 0) || 0,
            },
          });
          stats.upserted += 1;
        }
      } catch (err: any) {
        if (err?.code === 'P2002') stats.skipped += 1;
        else stats.errors += 1;
      }
    });

    if (watermark && !ctx.dryRun) await ctx.checkpoint(watermark);
    return stats;
  },
};

/**
 * Mirror a legacy removal as a cancel — never a row delete, so `progress` and the
 * purchase trail survive exactly as they do for a refund.
 *
 * Uses `resolveMember`, not `ensureMember`: a removal is not a reason to materialise
 * a member who has no row here yet. Nothing to cancel, nothing to create.
 */
async function cancelRemoved(
  ctx: SyncerCtx,
  stats: Stats,
  byPair: Map<string, { id: string; legacyId: number | null }>,
  r: any,
  legacyId: number,
  courseByLegacy: Map<number, string>,
): Promise<void> {
  const memberId = ctx.resolveMember(Number(r.member_id));
  const courseId = courseByLegacy.get(Number(r.course_id));
  if (!memberId || !courseId) {
    stats.skipped += 1;
    return;
  }
  // Only ever cancel the row THIS legacy row created. A pair now held by a different
  // legacyId (member re-enrolled) or by a new-system row (legacyId null — an app
  // purchase) is not ours to revoke.
  const existing = byPair.get(`${memberId}|${courseId}`);
  if (!existing || existing.legacyId !== legacyId) {
    stats.skipped += 1;
    return;
  }
  if (ctx.dryRun) {
    stats.voided = (stats.voided ?? 0) + 1;
    return;
  }
  // `isCanceled: false` in the guard makes a re-scan a no-op instead of re-stamping
  // `canceled_at` on every run.
  const res = await ctx.prisma.courseEnrollment.updateMany({
    where: { id: existing.id, isCanceled: false },
    data: { isCanceled: true, cancelationReason: LEGACY_CANCEL_REASON, canceledAt: new Date() },
  });
  if (res.count > 0) stats.voided = (stats.voided ?? 0) + 1;
  else stats.skipped += 1;
}
