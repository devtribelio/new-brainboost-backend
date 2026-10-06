/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Enrollments syncer — incremental port of migrate-members.ts::migrateEnrollments.
 *
 * SOURCE legacy course_enrollment (brainboost courses only) + payment status.
 * SCOPE  course.client = 'brainboost' OR a SUCCESS course_payment with client_product =
 *        'brainboost' for that course (course 6659 has client NULL but was sold as brainboost).
 * ACCESS course_payment SUCCESS OR bundle_payment SUCCESS OR both null (free).
 * KEY    legacyId = course_enrollment_id; also @@unique(memberId, courseId).
 * RE-ENROL legacy writes a NEW row; it re-points a dead (cancelled / expired-trial) pair row.
 * DELETE legacy `status = 0` -> isCanceled, unless something else still entitles the member.
 * Decision rules live in ./enrollment-rules.ts. See docs/legacy-resync-plan.md §6.
 */
import type { RowDataPacket } from 'mysql2/promise';
import { resyncConfig } from '../config';
import { emptyStats, type Stats, type Syncer, type SyncerCtx } from '../types';
import { errCode, nonEmpty, runConcurrent, sinceBound, toDate, WatermarkTracker } from '../util';
import {
  decideEnrollmentWrite,
  LEGACY_CANCEL_REASON,
  LEGACY_PAYMENT_REVOKED_REASON,
  mayCancelRemoved,
  type ExistingEnrollment,
} from './enrollment-rules';

/** In-scope legacy course ids: brainboost-owned, or sold as brainboost on the payment. */
export const BB_COURSE_IDS_SQL = `SELECT course_id FROM course WHERE client = 'brainboost'
  UNION
  SELECT course_id FROM course_payment
   WHERE client_product = 'brainboost' AND payment_status = 'SUCCESS' AND course_id IS NOT NULL`;

const ENROLLMENT_FROM = `course_enrollment e
         LEFT JOIN course_payment cp ON cp.course_payment_id = e.course_payment_id
         LEFT JOIN product_bundle_payment_detail bd
                ON bd.product_bundle_payment_detail_id = e.product_bundle_payment_detail_id
         LEFT JOIN product_bundle_payment bp ON bp.product_bundle_payment_id = bd.product_bundle_payment_id`;

/** SQL twin of the JS `access` check below. */
const HAS_ACCESS_SQL = `(cp.payment_status = 'SUCCESS' OR bp.payment_status = 'SUCCESS'
         OR (cp.payment_status IS NULL AND bp.payment_status IS NULL))`;

type CourseRef = { id: string; productId: string };

export const enrollmentsSyncer: Syncer = {
  name: 'enrollments',
  async run(ctx: SyncerCtx): Promise<Stats> {
    const stats = emptyStats();
    const since = sinceBound(ctx.since);

    // legacy course_id -> new Course (id + productId, the latter for the paid-order guard)
    const courseByLegacy = new Map<number, CourseRef>();
    for (const c of await ctx.prisma.course.findMany({
      where: { legacyCourseId: { not: null } },
      select: { id: true, productId: true, legacyCourseId: true },
    })) {
      if (c.legacyCourseId !== null) courseByLegacy.set(c.legacyCourseId, { id: c.id, productId: c.productId });
    }

    const [scopeRows] = await ctx.legacy.query<RowDataPacket[]>(BB_COURSE_IDS_SQL);
    const scopeCourseIds = (scopeRows as any[]).map((r) => Number(r.course_id));
    if (!scopeCourseIds.length) return stats;
    // A course with no Product/Course row here can't be synced — say so instead of
    // silently skipping its enrollments (the catalog row has to be created first).
    const unmapped = scopeCourseIds.filter((id) => !courseByLegacy.has(id));
    if (unmapped.length) ctx.log(`in-scope legacy courses with no PG course: ${unmapped.join(', ')}`);

    const [rows] = await ctx.legacy.query<RowDataPacket[]>(
      `SELECT e.course_enrollment_id, e.member_id, e.course_id, e.created, e.expired_date,
              e.certificate_code, e.certificate_created, e.progress, e.status,
              COALESCE(e.\`updated\`, e.\`created\`) AS wm,
              COALESCE(cp.\`updated\`, cp.\`created\`) AS course_pay_wm,
              COALESCE(bp.\`updated\`, bp.\`created\`) AS bundle_pay_wm,
              cp.payment_status AS course_ps, bp.payment_status AS bundle_ps
         FROM ${ENROLLMENT_FROM}
        WHERE e.course_id IN (?) AND e.member_id IS NOT NULL
          AND ( COALESCE(e.\`updated\`, e.\`created\`) > ?
                OR COALESCE(cp.\`updated\`, cp.\`created\`) > ?
                OR COALESCE(bp.\`updated\`, bp.\`created\`) > ? )
        ORDER BY COALESCE(e.\`updated\`, e.\`created\`) ASC, e.course_enrollment_id ASC`,
      [scopeCourseIds, since, since, since],
    );
    stats.scanned = (rows as any[]).length;
    if (!stats.scanned) return stats;

    // Preload existing enrollments keyed by (memberId,courseId). The enrollment carries
    // BOTH a legacyId unique AND a (memberId,courseId) unique — upserting on legacyId can
    // collide on the pair (e.g. a loser+winner enrolled in the same course, or a member
    // who bought the same course twice). Decide update/create/skip in memory so no P2002
    // is ever thrown, and never clobber a new-system enrollment's progress (legacyId=null).
    const byPair = new Map<string, ExistingEnrollment>();
    for (const e of await ctx.prisma.courseEnrollment.findMany({
      select: {
        id: true,
        memberId: true,
        courseId: true,
        legacyId: true,
        isCanceled: true,
        cancelationReason: true,
        expiredDate: true,
        progress: true,
      },
    })) {
      byPair.set(`${e.memberId}|${e.courseId}`, e);
    }

    const now = new Date();
    const losersByWinner = invertRedirect(ctx.redirect);
    const wm = new WatermarkTracker();
    await runConcurrent(rows as any[], resyncConfig.writeConcurrency, async (r: any) => {
      wm.seen(toDate(r.wm));
      // A refund/failed payment bumps only the payment's `updated` — track it so the checkpoint
      // advances (and the row is not re-scanned every tick).
      wm.seen(toDate(r.course_pay_wm));
      wm.seen(toDate(r.bundle_pay_wm));
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
        try {
          await cancelEnrollment(
            ctx, stats, byPair, r, legacyId, courseByLegacy, losersByWinner, LEGACY_CANCEL_REASON,
          );
        } catch (err) {
          stats.errors += 1;
          wm.failed(toDate(r.wm));
          ctx.log(`ERROR cancel course_enrollment_id=${legacyId}: ${errCode(err)}`);
        }
        return;
      }

      const paid = r.course_ps === 'SUCCESS' || r.bundle_ps === 'SUCCESS';
      const access = paid || (r.course_ps == null && r.bundle_ps == null);
      if (!access) {
        // Still active in legacy (status=1) but its payment is no longer SUCCESS (refund /
        // failed). Legacy bumps only `course_payment.updated` on that change, so the row
        // surfaces here thanks to the payment watermark above — and access now fails. Revoke
        // the entitlement, with the same guards as a removal (audit 07 #11).
        try {
          await cancelEnrollment(
            ctx, stats, byPair, r, legacyId, courseByLegacy, losersByWinner, LEGACY_PAYMENT_REVOKED_REASON,
          );
        } catch (err) {
          stats.errors += 1;
          wm.failed(toDate(r.wm));
          ctx.log(`ERROR revoke course_enrollment_id=${legacyId}: ${errCode(err)}`);
        }
        return;
      }
      const memberId = await ctx.ensureMember(Number(r.member_id));
      const courseId = courseByLegacy.get(Number(r.course_id))?.id;
      if (!memberId || !courseId) {
        stats.skipped += 1;
        return;
      }
      const pairKey = `${memberId}|${courseId}`;

      // read-decide-claim synchronously (no await between get and set) so a concurrent
      // row for the same pair sees the claim and takes the skip path, not a create race.
      const existing = byPair.get(pairKey);
      // An in-run claim (id 'new') has no row to re-point yet — another row got there first.
      const action = existing?.id === 'new' ? 'skip' : decideEnrollmentWrite(existing, legacyId, now, toDate(r.expired_date), paid);
      if (action === 'skip') {
        // Pair held by a new-system row (app purchase / employee grant) or by a live
        // legacy row — not ours to fight over.
        stats.skipped += 1;
        return;
      }
      if (ctx.dryRun) {
        stats.upserted += 1;
        return;
      }
      const incomingExpired = toDate(r.expired_date);
      const incomingProgress = Number(r.progress ?? 0) || 0;
      const revived = { legacyId, isCanceled: false, cancelationReason: null, expiredDate: incomingExpired };
      if (action === 'create') {
        byPair.set(pairKey, { id: 'new', progress: incomingProgress, ...revived }); // dedup further in-run rows
      } else if (action === 'repoint' || action === 'uncancel') {
        byPair.set(pairKey, { ...existing!, ...revived });
      }
      try {
        if (action === 'create') {
          await ctx.prisma.courseEnrollment.create({
            data: {
              legacyId,
              memberId,
              courseId,
              dateStart: toDate(r.created),
              expiredDate: incomingExpired,
              certificateCode: nonEmpty(r.certificate_code),
              certificateCreated: toDate(r.certificate_created),
              progress: incomingProgress,
            },
          });
        } else if (action === 'repoint') {
          // Legacy re-enrolment (e.g. bought after the free trial expired) wrote a new
          // row; the pair here is still held by the dead old one. Move it onto the new
          // legacyId instead of skipping — else the later removal of the old row is the
          // only thing this syncer ever sees, and the paying buyer loses access.
          await ctx.prisma.courseEnrollment.update({
            where: { id: existing!.id },
            data: {
              legacyId,
              isCanceled: false,
              canceledAt: null,
              cancelationReason: null,
              expiredDate: incomingExpired,
              progress: Math.max(existing!.progress, incomingProgress),
            },
          });
        } else {
          // refresh (same legacyId) — plus, for a legacy reactivation (status 0 -> 1) of a
          // row we cancelled as `legacy_removed`, lift that cancel. A refund cancel stays.
          await ctx.prisma.courseEnrollment.update({
            where: { id: existing!.id },
            data: {
              expiredDate: incomingExpired,
              certificateCode: nonEmpty(r.certificate_code),
              certificateCreated: toDate(r.certificate_created),
              progress: incomingProgress,
              ...(action === 'uncancel' ? { isCanceled: false, canceledAt: null, cancelationReason: null } : {}),
            },
          });
        }
        stats.upserted += 1;
      } catch (err: any) {
        if (err?.code === 'P2002') {
          stats.skipped += 1;
        } else {
          stats.errors += 1;
          wm.failed(toDate(r.wm));
          ctx.log(`ERROR write course_enrollment_id=${legacyId}: ${errCode(err)}`);
        }
      }
    });

    await ctx.checkpoint(wm.result(ctx.runStart));
    return stats;
  },
};

/** winner legacy member id -> loser ids redirected to it (from member_redirect). */
function invertRedirect(redirect: Map<number, number>): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const [loser, winner] of redirect) out.set(winner, [...(out.get(winner) ?? []), loser]);
  return out;
}

/** Every legacy member id that resolves to the same new member as `legacyMemberId`. */
function sameMemberLegacyIds(
  redirect: Map<number, number>,
  losersByWinner: Map<number, number[]>,
  legacyMemberId: number,
): number[] {
  const winner = redirect.get(legacyMemberId) ?? legacyMemberId;
  return [...new Set([legacyMemberId, winner, ...(losersByWinner.get(winner) ?? [])])];
}

/**
 * Mirror a lost entitlement as a cancel — never a row delete, so `progress` and the purchase
 * trail survive exactly as they do for a refund. Shared by two sources:
 *   - legacy removal (`status = 0`) → cancelationReason `legacy_removed`
 *   - payment no longer SUCCESS (refund/failed) → `legacy_payment_revoked`
 * Both are ours to lift if legacy re-grants access.
 *
 * Uses `resolveMember`, not `ensureMember`: a lost entitlement is not a reason to materialise
 * a member who has no row here yet. Nothing to cancel, nothing to create.
 */
async function cancelEnrollment(
  ctx: SyncerCtx,
  stats: Stats,
  byPair: Map<string, ExistingEnrollment>,
  r: any,
  legacyId: number,
  courseByLegacy: Map<number, CourseRef>,
  losersByWinner: Map<number, number[]>,
  reason: string,
): Promise<void> {
  const memberId = ctx.resolveMember(Number(r.member_id));
  const course = courseByLegacy.get(Number(r.course_id));
  if (!memberId || !course) {
    stats.skipped += 1;
    return;
  }
  const pairKey = `${memberId}|${course.id}`;
  // Only ever cancel the row THIS legacy row created. A pair now held by a different
  // legacyId (member re-enrolled) or by a new-system row (legacyId null — an app
  // purchase, an employee grant) is not ours to revoke. Cheap check first.
  const existing = byPair.get(pairKey);
  if (!mayCancelRemoved({ existing, legacyId, otherActiveLegacyRows: 0, hasPaidOrder: false })) {
    stats.skipped += 1;
    return;
  }

  // Something else still entitles the member? Another active legacy enrolment for the
  // course (incl. one on a deduped loser account) or a paid order in the new system.
  const [others] = await ctx.legacy.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM ${ENROLLMENT_FROM}
      WHERE e.course_id = ? AND e.member_id IN (?) AND e.course_enrollment_id <> ?
        AND e.status = 1 AND ${HAS_ACCESS_SQL}`,
    [Number(r.course_id), sameMemberLegacyIds(ctx.redirect, losersByWinner, Number(r.member_id)), legacyId],
  );
  const paid = await ctx.prisma.commerceTransaction.findFirst({
    // amount > 0: a TRIAL grant or 100%-voucher order settles PAID at zero and is not a purchase
    where: { memberId, productId: course.productId, status: 'PAID', amount: { gt: 0 } },
    select: { id: true },
  });
  if (
    !mayCancelRemoved({
      existing: byPair.get(pairKey),
      legacyId,
      otherActiveLegacyRows: Number((others as any[])[0]?.n ?? 0),
      hasPaidOrder: paid !== null,
    })
  ) {
    stats.skipped += 1;
    return;
  }
  if (ctx.dryRun) {
    stats.voided = (stats.voided ?? 0) + 1;
    return;
  }
  // `legacyId` + `isCanceled: false` in the guard: a re-scan is a no-op instead of
  // re-stamping `canceled_at`, and a concurrent re-point of this pair is never undone.
  const res = await ctx.prisma.courseEnrollment.updateMany({
    where: { id: existing!.id, legacyId, isCanceled: false },
    data: { isCanceled: true, cancelationReason: reason, canceledAt: new Date() },
  });
  if (res.count > 0) {
    const current = byPair.get(pairKey);
    if (current?.legacyId === legacyId) {
      byPair.set(pairKey, { ...current, isCanceled: true, cancelationReason: reason });
    }
    stats.voided = (stats.voided ?? 0) + 1;
  } else stats.skipped += 1;
}
