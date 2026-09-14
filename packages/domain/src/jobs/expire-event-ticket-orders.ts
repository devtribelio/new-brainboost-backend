import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';

/**
 * Give back seats held by orders that will never be paid.
 *
 * Why this job has to exist: quota is counted from ticket rows in RESERVED or
 * ISSUED (docs/event-ticketing.md K-1), and nothing else releases a RESERVED
 * seat. `expirePendingPayments` does not cover it — that one sweeps
 * `commerce_payments`, so an order abandoned BEFORE a payment row exists (the
 * common case: the buyer closes the tab on the payment screen) is invisible to
 * it and would hold its seats forever.
 *
 * Two sources of dead seats, both handled here:
 *   1. PENDING orders past `expired_at` — nobody paid in time.
 *   2. CANCELED / EXPIRED / FAILED orders that still carry RESERVED tickets —
 *      most importantly `PaymentService.cancel()`, which flips the order and
 *      emits NO event, so there is nothing for a listener to hook. Sweeping it
 *      here is what keeps that path from leaking seats without touching the
 *      payment service at all.
 *
 * SCOPED TO EVENT TICKETS ON PURPOSE (docs/event-ticketing.md R-14). A generic
 * "expire every stale PENDING order" would, on its first run, flip every course
 * checkout ever abandoned — a backlog of unknown size that the mobile app still
 * lists under "menunggu pembayaran". Widening it is a separate decision that
 * needs that number first; it is not a side effect of shipping ticketing.
 */
export async function expireEventTicketOrders(
  now: Date = new Date(),
): Promise<{ ordersExpired: number; ticketsReleased: number }> {
  const stale = await prisma.eventTicket.findMany({
    where: {
      status: 'RESERVED',
      OR: [
        { transaction: { status: 'PENDING', expiredAt: { not: null, lt: now } } },
        { transaction: { status: { in: ['CANCELED', 'EXPIRED', 'FAILED'] } } },
      ],
    },
    select: { transactionId: true },
    distinct: ['transactionId'],
  });

  let ordersExpired = 0;
  let ticketsReleased = 0;

  for (const { transactionId } of stale) {
    try {
      const released = await prisma.$transaction(async (txdb) => {
        // Conditional, not a blind update: an order paid in the moment between
        // the scan and here is still PENDING→PAID elsewhere, and must keep its
        // seats. Zero rows matched simply means someone else got there first.
        const expired = await txdb.commerceTransaction.updateMany({
          where: { id: transactionId, status: 'PENDING', expiredAt: { not: null, lt: now } },
          data: { status: 'EXPIRED' },
        });
        if (expired.count > 0) ordersExpired++;

        const tickets = await txdb.eventTicket.updateMany({
          // Guarded by the order's own status so a payment that landed a
          // millisecond ago cannot have its seats taken away.
          where: {
            transactionId,
            status: 'RESERVED',
            transaction: { status: { in: ['CANCELED', 'EXPIRED', 'FAILED'] } },
          },
          data: { status: 'EXPIRED' },
        });
        return tickets.count;
      });
      ticketsReleased += released;
    } catch (err) {
      logger.error({ err, transactionId }, '[event-expire] failed to release seats');
    }
  }

  if (ticketsReleased > 0 || ordersExpired > 0) {
    logger.info({ ordersExpired, ticketsReleased }, '[event-expire] released stale seats');
  }
  return { ordersExpired, ticketsReleased };
}
