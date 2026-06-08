import { logger } from '@bb/common/config/logger';
import { commerceEvents } from '@bb/common/events/commerce-events';
import { affiliateEvents } from '@bb/common/events/affiliate-events';
import { enqueueComms } from '@bb/common/services/comms-outbox';

/**
 * Outbound email producer for commerce events. Enqueues a transactional email
 * to the comms outbox; the comms-relay publishes it and bb-comms renders +
 * sends it (reading the data from Postgres by refId). See docs/adr/0002.
 *
 * Best-effort + post-commit (the event fires after the payment transaction
 * commits) — same pattern as the notification listener. The outbox itself gives
 * at-least-once from relay → queue; only this initial enqueue is best-effort,
 * which is acceptable for a receipt.
 */
export function registerCommsEmailListeners(): void {
  commerceEvents.on('commerce.payment.success', async (e) => {
    // Renewals are subscription events, not first-purchase receipts — skip for now.
    if (e.isRenewal) return;
    try {
      await enqueueComms({
        type: 'CoursePaymentSuccess',
        channel: 'email',
        priority: 'normal',
        refId: e.transactionId, // bb-comms reads commerce_transactions by this id
      });
    } catch (err) {
      logger.error(
        { err, transactionId: e.transactionId },
        '[comms-email] failed to enqueue CoursePaymentSuccess',
      );
    }
  });

  // Email the earner when an affiliate commission is created (one per chain level).
  affiliateEvents.on('affiliate.commission.created', async (e) => {
    try {
      await enqueueComms({
        type: 'AffiliatorCommisionCourse',
        channel: 'email',
        priority: 'normal',
        refId: e.commissionId, // bb-comms reads affiliate_commissions by this id
      });
    } catch (err) {
      logger.error(
        { err, commissionId: e.commissionId },
        '[comms-email] failed to enqueue AffiliatorCommisionCourse',
      );
    }
  });
}
