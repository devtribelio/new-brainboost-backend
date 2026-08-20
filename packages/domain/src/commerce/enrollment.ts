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
 *    A live trial says YES.
 *  - `OWNED_FOR_PURCHASE`  = "is this course already paid for?"
 *    A live trial says NO, otherwise the trial would lock the member out of
 *    buying the very course it is advertising.
 */

/**
 * Content-access filter. `expired_date` is honoured ONLY for trial rows:
 * a retail/legacy row (`via_voucher_id IS NULL`) is valid by existence, because
 * the legacy migration filled `expired_date` on lifetime purchases and the
 * pre-trial gate never read it — honouring it globally would cut off paying
 * lifetime buyers.
 *
 * A function, not a const: `new Date()` in a module-level object would freeze at
 * process boot and every trial would look valid (or expired) forever.
 */
export function activeEnrollment(now: Date = new Date()): Prisma.CourseEnrollmentWhereInput {
  return {
    isCanceled: false,
    OR: [{ viaVoucherId: null }, { expiredDate: { gt: now } }],
  };
}

/**
 * Purchase-ownership filter: a paid (or legacy) enrollment that is not refunded.
 * Deliberately ignores trial rows, so a member on trial can still check out — the
 * trial must never block the sale it exists to advertise.
 *
 * Checkout guard ONLY. The catalog's `not_purchased` shelf uses `activeEnrollment()`
 * instead: a course the member can already open does not belong on a "belum dibeli"
 * shelf, even though it is genuinely not paid for yet.
 */
export const OWNED_FOR_PURCHASE = {
  isCanceled: false,
  viaVoucherId: null,
} as const satisfies Prisma.CourseEnrollmentWhereInput;

/** True when `memberId` holds a live (non-refunded, non-expired) enrollment in `courseId`. */
export async function hasActiveEnrollment(memberId: string, courseId: string): Promise<boolean> {
  const row = await prisma.courseEnrollment.findFirst({
    where: { memberId, courseId, ...activeEnrollment() },
    select: { id: true },
  });
  return row != null;
}
