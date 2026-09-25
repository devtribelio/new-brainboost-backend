import { prisma } from '@bb/db';

export const EVENT_TICKET_PRODUCT_TYPE = 'event_ticket';

/**
 * Whether a paid order bought event tickets rather than a course.
 *
 * Read from the DB rather than carried on `commerce.payment.success`, for the
 * same reason `loadTrialGrant` is: an optional event field reads as "false" to
 * any emitter that forgets to set it, and that failure is silent. The event is
 * emitted from four channels; a lookup here is one indexed read and cannot be
 * forgotten by a fifth.
 */
export async function isEventTicketOrder(productId: string | null | undefined): Promise<boolean> {
  if (!productId) return false;
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { type: true },
  });
  return product?.type === EVENT_TICKET_PRODUCT_TYPE;
}
