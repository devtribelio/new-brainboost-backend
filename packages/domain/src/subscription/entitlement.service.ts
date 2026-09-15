import type { CourseEnrollment, MemberSubscription, SubscriptionPlan } from '@prisma/client';
import { prisma } from '@bb/db';
import { forbidden, ERROR_CODES } from '@bb/common/exceptions';

export type ActiveSubscription = MemberSubscription & { plan: SubscriptionPlan };

/**
 * Subscription entitlement + lazy enrollment (PRD BE-06).
 *
 * Entitled ⇔ the member HOLDS A SEAT (owner sits on seat 1) on a sub with
 * status=ACTIVE and coalesce(graceUntil, expiresAt) > now.
 *
 * Enrollment validity predicate — the sacred rule, keyed on `expired_date` and
 * NOT on the grant markers:
 * - expired_date NULL (paid/legacy lifetime) → ALWAYS valid.
 * - expired_date set → valid only while it is in the future, whoever wrote it:
 *   - via_subscription_id (lazy row) — renewal bumps the date
 *     (SubscriptionService); seat removal/leave zeroes it (SeatService); expiry
 *     lets it die on its own, no cleanup job needed;
 *   - via_voucher_id (free-trial row) — set once at grant time to
 *     grant + voucher.trialDays;
 *   - no marker at all — a resynced LEGACY free trial. Legacy vouchers are not
 *     migrated, so it has no marker to key on; a marker-keyed gate read it as
 *     permanent access, which is the bug this rule was corrected for (2026-09-14).
 *     Measured on legacy: all 114 enrollments with a non-null expired_date trace
 *     to a `voucher_redeem` row with free_trial_activated = 1 — the column means
 *     trial, never lifetime.
 *
 * This is the in-memory form of `activeEnrollment()` in commerce/enrollment.ts.
 * The two MUST stay identical — one is the SQL filter behind list badges, the
 * other gates content access, and a drift between them shows as a course the
 * catalog says you own but the player refuses to open.
 */
export class EntitlementService {
  async getActiveSubscriptionForMember(memberId: string): Promise<ActiveSubscription | null> {
    const now = new Date();
    const seat = await prisma.subscriptionSeat.findFirst({
      where: {
        memberId,
        subscription: {
          status: 'ACTIVE',
          OR: [{ graceUntil: { gt: now } }, { graceUntil: null, expiresAt: { gt: now } }],
        },
      },
      include: { subscription: { include: { plan: true } } },
    });
    return seat?.subscription ?? null;
  }

  async hasActiveSubscription(memberId: string): Promise<boolean> {
    return (await this.getActiveSubscriptionForMember(memberId)) !== null;
  }

  /**
   * In-memory mirror of `activeEnrollment()` — keep the two byte-for-byte in step,
   * or a list badge disagrees with the media gate.
   *
   * A row is time-boxed by its `expired_date`, whoever wrote it (free-trial voucher,
   * subscription lazy row, or a resynced LEGACY trial that carries no marker at all);
   * a permanent grant leaves the column NULL. The markers are NOT read here — a
   * marker-keyed gate reads a legacy trial as permanent access.
   *
   * A refund soft-cancels the row instead of deleting it (`is_canceled`), so the
   * flag is checked FIRST: a cancelled permanent row would otherwise pass on the
   * null-date branch and keep serving a refunded member.
   */
  isEnrollmentValid(e: Pick<CourseEnrollment, 'expiredDate' | 'isCanceled'>): boolean {
    if (e.isCanceled) return false;
    return e.expiredDate === null || e.expiredDate > new Date();
  }

  /**
   * The content gate: valid enrollment OR active subscription. A subscriber
   * without a (valid) enrollment row gets one lazily — expired_date mirrors the
   * sub's expiry so tracker/challenge/progress work unchanged. The upsert's
   * update branch can only ever touch a lazy row: a retail row is always valid
   * and returns on the fast path above it.
   */
  async assertCourseAccess(memberId: string, courseId: string): Promise<void> {
    const enrollment = await prisma.courseEnrollment.findUnique({
      where: { memberId_courseId: { memberId, courseId } },
    });
    if (enrollment && this.isEnrollmentValid(enrollment)) return;

    const sub = await this.getActiveSubscriptionForMember(memberId);
    // Coded, not free-form: the media/bonus gates both answer COURSE_NOT_ENROLLED,
    // and the client branches on `error.code`.
    if (!sub) throw forbidden(ERROR_CODES.COURSE_NOT_ENROLLED);

    await prisma.courseEnrollment.upsert({
      where: { memberId_courseId: { memberId, courseId } },
      create: {
        memberId,
        courseId,
        viaSubscriptionId: sub.id,
        expiredDate: sub.expiresAt,
        dateStart: new Date(),
      },
      // Refresh a stale lazy row (old lapsed sub → this member's current sub).
      // Also un-cancels a refunded retail row: the refund revoked the *purchase*,
      // but the sub grants access independently — it becomes a lazy row that dies
      // with the subscription instead of a resurrected lifetime one.
      update: {
        viaSubscriptionId: sub.id,
        expiredDate: sub.expiresAt,
        isCanceled: false,
        cancelationReason: null,
        canceledAt: null,
      },
    });
  }
}
