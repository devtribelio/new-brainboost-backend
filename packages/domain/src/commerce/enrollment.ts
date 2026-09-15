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
 * Content-access filter. A time-boxed grant is honoured by its `expired_date`,
 * whoever wrote it — this app's free-trial voucher, or a LEGACY free-trial
 * voucher whose redemption never crossed into this database.
 *
 * Keyed on the date rather than on the `via_voucher_id` marker, because a legacy
 * trial arrives with no marker to key on: legacy vouchers are not migrated (there
 * is no `migrate-voucher` script and nothing fills `Voucher.legacyId`), so the
 * resynced row lands `via_voucher_id = NULL` and a marker-keyed gate reads it as
 * permanent access.
 *
 * The premise this replaces — "the legacy migration filled `expired_date` on
 * lifetime purchases, so honouring it globally would cut off paying buyers" — was
 * not true. Measured on legacy 2026-09-14 (brainboost scope): 70 936 enrollments,
 * 114 with a non-null `expired_date`, and all 114 trace to a `voucher_redeem` row
 * with `free_trial_activated = 1`. It matches the legacy writers: the only two
 * places that set the column (`TBCourse_Member::joined()` and the
 * `TBModel_VoucherRedeem` created-hook) are both the trial path, and legacy
 * enforced expiry by deleting the row, never by reading the date back.
 *
 * A function, not a const: `new Date()` in a module-level object would freeze at
 * process boot and every trial would look valid (or expired) forever.
 */
export function activeEnrollment(now: Date = new Date()): Prisma.CourseEnrollmentWhereInput {
  return {
    isCanceled: false,
    OR: [{ expiredDate: null }, { expiredDate: { gt: now } }],
  };
}

/**
 * Purchase-ownership filter: a paid (or legacy) enrollment that is not refunded.
 * Deliberately ignores trial rows, so a member on trial can still check out — the
 * trial must never block the sale it exists to advertise.
 *
 * Both trial shapes have to be excluded, because they do not look alike: a trial
 * granted here carries `via_voucher_id`, while a resynced legacy trial carries only
 * `expired_date`. A paid grant is permanent, so it has neither.
 *
 * Checkout guard ONLY. The catalog's `not_purchased` shelf uses `activeEnrollment()`
 * instead: a course the member can already open does not belong on a "belum dibeli"
 * shelf, even though it is genuinely not paid for yet.
 */
export const OWNED_FOR_PURCHASE = {
  isCanceled: false,
  viaVoucherId: null,
  expiredDate: null,
} as const satisfies Prisma.CourseEnrollmentWhereInput;

/** True when `memberId` holds a live (non-refunded, non-expired) enrollment in `courseId`. */
export async function hasActiveEnrollment(memberId: string, courseId: string): Promise<boolean> {
  const row = await prisma.courseEnrollment.findFirst({
    where: { memberId, courseId, ...activeEnrollment() },
    select: { id: true },
  });
  return row != null;
}
