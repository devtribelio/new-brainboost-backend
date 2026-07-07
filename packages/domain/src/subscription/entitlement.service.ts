import type { CourseEnrollment, MemberSubscription, SubscriptionPlan } from '@prisma/client';
import { prisma } from '@bb/db';
import { ForbiddenException } from '@bb/common/exceptions';

export type ActiveSubscription = MemberSubscription & { plan: SubscriptionPlan };

/**
 * Subscription entitlement + lazy enrollment (PRD BE-06).
 *
 * Entitled ⇔ the member HOLDS A SEAT (owner sits on seat 1) on a sub with
 * status=ACTIVE and coalesce(graceUntil, expiresAt) > now.
 *
 * Enrollment validity predicate — the sacred rule:
 * - via_subscription_id NULL (retail/legacy) → ALWAYS valid. expired_date is
 *   deliberately ignored: legacy migration filled it on lifetime purchases, and
 *   the pre-subscription gate never read it. Honoring it would cut off paying
 *   lifetime buyers.
 * - via_subscription_id set (lazy row) → valid only while expired_date > now.
 *   Renewal bumps the date (SubscriptionService); seat removal/leave zeroes it
 *   (SeatService); expiry lets it die on its own — no cleanup job needed.
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

  /** See class doc — retail rows are valid by existence, lazy rows by date. */
  isEnrollmentValid(e: Pick<CourseEnrollment, 'viaSubscriptionId' | 'expiredDate'>): boolean {
    if (!e.viaSubscriptionId) return true;
    return e.expiredDate !== null && e.expiredDate > new Date();
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
    if (!sub) throw new ForbiddenException('Not enrolled in this course');

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
      update: { viaSubscriptionId: sub.id, expiredDate: sub.expiresAt },
    });
  }
}
