import { prisma } from '@bb/db';
import type { Prisma } from '@prisma/client';

/**
 * A refund revokes course access by soft-cancelling the enrollment row
 * (`is_canceled = true`) instead of deleting it, so progress and purchase
 * history survive. Every access check must therefore filter on the flag — a
 * bare row lookup grants a refunded member full access.
 *
 * Both helpers live here so the filter has exactly one definition: the bug this
 * fixes was six independent call sites each doing their own row lookup.
 *
 * Two predicates, not one — they answer different questions:
 *  - `activeEnrollment()` = "may this member consume the content right now?"
 *    A live trial or a live subscription lazy row says YES.
 *  - `OWNED_FOR_PURCHASE`  = "is this course already paid for outright?"
 *    A trial or subscription row says NO, otherwise a time-boxed grant would
 *    lock the member out of buying the very course it is advertising.
 *
 * Two grant markers feed both: `via_voucher_id` (free trial) and
 * `via_subscription_id` (subscription lazy row). They are structurally identical
 * — a set marker means the row is time-boxed — so both predicates treat them the
 * same way and neither is allowed to drift from the other.
 */

/**
 * Content-access filter. `expired_date` is honoured ONLY for GRANTED rows: a
 * retail/legacy row (both markers NULL) is valid by existence, because the legacy
 * migration filled `expired_date` on lifetime purchases and the pre-grant gate
 * never read it — honouring it globally would cut off paying lifetime buyers.
 *
 * Must mirror `EntitlementService.isEnrollmentValid` (BE-06) exactly: this is the
 * SQL form, that is the in-memory form, and list badges must not disagree with
 * the media gate.
 *
 * A function, not a const: `new Date()` in a module-level object would freeze at
 * process boot and every grant would look valid (or expired) forever.
 */
export function activeEnrollment(now: Date = new Date()): Prisma.CourseEnrollmentWhereInput {
  return {
    isCanceled: false,
    OR: [{ viaVoucherId: null, viaSubscriptionId: null }, { expiredDate: { gt: now } }],
  };
}

/**
 * Purchase-ownership filter: a paid (or legacy) enrollment that is not refunded.
 * Deliberately ignores BOTH granted kinds, so a member can still check out while
 * on a free trial or holding the course through a subscription — the trial must
 * never block the sale it exists to advertise, and buying retail while subscribed
 * is the documented upgrade-to-lifetime path (the payment-success listener clears
 * the marker).
 *
 * Checkout guard ONLY. The catalog's `not_purchased` shelf uses `activeEnrollment()`
 * instead: a course the member can already open does not belong on a "belum dibeli"
 * shelf, even though it is genuinely not paid for yet.
 */
export const OWNED_FOR_PURCHASE = {
  isCanceled: false,
  viaVoucherId: null,
  viaSubscriptionId: null,
} as const satisfies Prisma.CourseEnrollmentWhereInput;

/** True when `memberId` holds a live (non-refunded, non-expired) enrollment in `courseId`. */
export async function hasActiveEnrollment(memberId: string, courseId: string): Promise<boolean> {
  const row = await prisma.courseEnrollment.findFirst({
    where: { memberId, courseId, ...activeEnrollment() },
    select: { id: true },
  });
  return row != null;
}
