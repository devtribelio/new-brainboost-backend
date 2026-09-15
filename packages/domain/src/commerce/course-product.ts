import { prisma } from '@bb/db';

/**
 * Is this product a course the member can be enrolled in?
 *
 * Keyed on the existence of a `courses` row, NOT on `products.type`. That gate
 * already shipped once and cost a bug: `type === 'course'` silently dropped
 * `mini_course` purchases, so commission committed but enrollment never did (see
 * `payment-success.listener.ts`). A linked course row covers every course-backed
 * type, including the ones not invented yet.
 *
 * It is also a whitelist, which is the point wherever the answer decides whether
 * money moves. The obvious alternative — "not an event ticket" (`isEventTicketOrder`)
 * — is a blacklist: the next product type that appears (a subscription SKU, say)
 * passes it by default, and nobody decided that.
 */
export async function isCourseProduct(productId: string): Promise<boolean> {
  const course = await prisma.course.findUnique({
    where: { productId },
    select: { id: true },
  });
  return course != null;
}
