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
 */
export const ACTIVE_ENROLLMENT = { isCanceled: false } as const satisfies Prisma.CourseEnrollmentWhereInput;

/** True when `memberId` holds a live (non-refunded) enrollment in `courseId`. */
export async function hasActiveEnrollment(memberId: string, courseId: string): Promise<boolean> {
  const row = await prisma.courseEnrollment.findFirst({
    where: { memberId, courseId, ...ACTIVE_ENROLLMENT },
    select: { id: true },
  });
  return row != null;
}
