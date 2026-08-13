import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { commerceEvents } from '@bb/common/events/commerce-events';
import { affiliateEvents } from '@bb/common/events/affiliate-events';
import { enqueueComms } from '@bb/common/services/comms-outbox';
import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';

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
    // Renewals are subscription events, not first-purchase receipts — skip.
    if (e.isRenewal) return;
    try {
      // Plan-backed products get the SubscriptionActivated/Renewed receipts
      // (subscription-email.listener, BE-18) — the course receipt would be a
      // wrong-context double.
      const plan = await prisma.subscriptionPlan.findUnique({
        where: { productId: e.productId },
        select: { id: true },
      });
      if (plan) return;
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

  // Business sale alert — the single-tenant replacement for legacy's chief
  // "Produk X Berhasil Terjual!" email (TBEmail_Engine_CoursePaymentSuccess).
  // Recipients come from app_settings `sales.alertEmail` (comma-separated,
  // empty = off) instead of a per-network owner. Subscription sales/renewals
  // are deferred (isRenewal skip below; plan-backed skip lands with the
  // subscription branch).
  commerceEvents.on('commerce.payment.success', async (e) => {
    if (e.isRenewal) return;
    try {
      const raw = await settingsService.get(SETTING_KEYS.salesAlertEmail, '');
      const recipients = raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.includes('@'));
      if (recipients.length === 0) return;
      for (const recipient of recipients) {
        await enqueueComms({
          type: 'SaleAlert',
          channel: 'email',
          priority: 'normal',
          refId: e.transactionId, // bb-comms reads commerce_transactions by this id
          recipient, // relay maps this to msg.to — bb-comms sends there, not to the buyer
        });
      }
    } catch (err) {
      logger.error(
        { err, transactionId: e.transactionId },
        '[comms-email] failed to enqueue SaleAlert',
      );
    }
  });

  commerceEvents.on('commerce.payment.refunded', async (e) => {
    try {
      await enqueueComms({
        type: 'CommerceRefunded',
        channel: 'email',
        priority: 'normal',
        refId: e.transactionId,
      });
    } catch (err) {
      logger.error(
        { err, transactionId: e.transactionId },
        '[comms-email] failed to enqueue CommerceRefunded',
      );
    }
  });

  commerceEvents.on('commerce.payment.expired', async (e) => {
    try {
      await enqueueComms({
        type: 'CommercePaymentExpired',
        channel: 'email',
        priority: 'normal',
        refId: e.transactionId,
      });
    } catch (err) {
      logger.error(
        { err, transactionId: e.transactionId },
        '[comms-email] failed to enqueue CommercePaymentExpired',
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
