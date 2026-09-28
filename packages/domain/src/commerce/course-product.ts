import { prisma } from '@bb/db';

/** The one `products.type` a first-purchase voucher may discount. */
export const FULL_COURSE_PRODUCT_TYPE = 'course';

/**
 * May a first-purchase voucher discount this product?
 *
 * A whitelist of exactly one product type, which is the point wherever the answer
 * decides whether money moves. `bundle`, `book`, `digital`, `event_ticket` and
 * every type not invented yet are refused by default, so nobody has to remember to
 * add them. The obvious alternative — "not an event ticket" (`isEventTicketOrder`)
 * — is a blacklist, and the next type to appear passes it without anyone deciding.
 *
 * `mini_course` is deliberately outside the scope (decided 2026-09-25). It used to
 * pass, because the gate asked whether the product had a `courses` row and a mini
 * course has one. The discount is for full courses only, so the question had to
 * narrow from "is this course-backed?" to "is this THE course type?".
 *
 * Do NOT reuse this as an enrollment or access gate. Those must stay keyed on the
 * `courses` row: `payment-success.listener.ts` once asked `type === 'course'` and
 * silently dropped every `mini_course` purchase, committing the commission while
 * never granting the enrollment. The two questions read alike and are not the same.
 */
export async function isFullCourseProduct(productId: string): Promise<boolean> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { type: true },
  });
  return product?.type === FULL_COURSE_PRODUCT_TYPE;
}
