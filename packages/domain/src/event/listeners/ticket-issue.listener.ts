import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { commerceEvents } from '@bb/common/events/commerce-events';
import { enqueueComms } from '@bb/common/services/comms-outbox';

/**
 * Issue the tickets of a paid order, and queue their emails.
 *
 * Every ticket is written RESERVED at checkout and only becomes valid here, so
 * this listener is the single point where a seat turns into something a person
 * can present. It fires for every `commerce.payment.success`; an order with no
 * RESERVED tickets (i.e. every course purchase) leaves after one indexed read.
 *
 * Idempotency comes from the transition itself, not from a dedupe key: the flip
 * is `updateMany … WHERE status = 'RESERVED'`, so a redelivered Xendit webhook
 * matches zero rows and sends nothing. The emails are enqueued INSIDE that same
 * transaction, which is what keeps "tickets issued" and "emails queued" from
 * ever disagreeing — a crash between them rolls both back, and the redelivery
 * does the whole thing.
 *
 * Deploy order is binding: bb-comms must know `EventTicketIssued` and
 * `EventOrderSummary` BEFORE this ships, or every ticket email lands in the DLQ.
 */
export function registerEventTicketListeners(): void {
  commerceEvents.on('commerce.payment.success', async (e) => {
    try {
      const pending = await prisma.eventTicket.findMany({
        where: { transactionId: e.transactionId, status: 'RESERVED' },
        select: { id: true },
      });
      if (pending.length === 0) return;

      const now = new Date();
      await prisma.$transaction(async (txdb) => {
        const issued = await txdb.eventTicket.updateMany({
          where: { transactionId: e.transactionId, status: 'RESERVED' },
          // `emailSentAt` is stamped when the message is handed to the outbox,
          // not when SES accepts it: this is the moment after which it must
          // never be enqueued again, which is what the column is guarding.
          data: { status: 'ISSUED', issuedAt: now, emailSentAt: now },
        });
        // Another delivery of the same event won the race — it has already
        // queued these emails, so queueing them again would duplicate them.
        if (issued.count === 0) return;

        // One email per attendee: this is the one that gets forwarded or shown
        // at the door, so it has to stand on its own.
        for (const ticket of pending) {
          await enqueueComms(
            { type: 'EventTicketIssued', channel: 'email', priority: 'normal', refId: ticket.id },
            txdb,
          );
        }
        // Plus one summary to whoever paid — every code in one place. A buyer
        // who bought for themselves gets both, deliberately.
        await enqueueComms(
          {
            type: 'EventOrderSummary',
            channel: 'email',
            priority: 'normal',
            refId: e.transactionId,
          },
          txdb,
        );
      });

      logger.info(
        { transactionId: e.transactionId, tickets: pending.length },
        '[event] tickets issued',
      );
    } catch (err) {
      logger.error({ err, transactionId: e.transactionId }, '[event] failed to issue tickets');
    }
  });

  /**
   * A refunded order's tickets stop being valid.
   *
   * Refunds are out of scope for phase 1 as a product flow (there is no refund
   * UI), but the event is already emitted by the Xendit webhook and the ingest
   * path, so finance issuing a refund from the Xendit dashboard would otherwise
   * leave a paid-for-then-returned ticket that still scans as good. VOID rather
   * than EXPIRED: the seat was given up deliberately, and the distinction is
   * what the backoffice ticket list reads.
   *
   * The seat comes back to the quota either way — the quota counts RESERVED and
   * ISSUED, and VOID is neither.
   */
  commerceEvents.on('commerce.payment.refunded', async (e) => {
    try {
      const voided = await prisma.eventTicket.updateMany({
        where: { transactionId: e.transactionId, status: 'ISSUED' },
        data: { status: 'VOID' },
      });
      if (voided.count > 0) {
        logger.info(
          { transactionId: e.transactionId, tickets: voided.count },
          '[event] tickets voided after refund',
        );
      }
    } catch (err) {
      logger.error({ err, transactionId: e.transactionId }, '[event] failed to void tickets');
    }
  });
}
