import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { commerceEvents } from '@bb/common/events/commerce-events';
import { subscriptionEvents } from '@bb/common/events/subscription-events';
import { SubscriptionService } from '../subscription.service';

const subscriptionService = new SubscriptionService();

/**
 * Bridges commerce → subscription (PRD BE-08). Xendit webhooks, RevenueCat
 * webhooks and purchase-ingest all converge on commerce.payment.success, so
 * this single listener activates subs for every channel; products without a
 * plan no-op inside activateFromPayment. subscription.* events are emitted
 * AFTER the service's transaction committed (we're past the await).
 */
export function registerSubscriptionActivationListeners(): void {
  commerceEvents.on('commerce.payment.success', async (e) => {
    try {
      const result = await subscriptionService.activateFromPayment({
        ownerId: e.memberId,
        productId: e.productId,
        transactionId: e.transactionId,
        source: e.channel === 'revenuecat' ? 'revenuecat' : 'xendit',
        // Provider facts passthrough (BE-13): RC binds providerRef + authoritative expiry.
        providerRef: e.subscription?.providerRef ?? null,
        providerExpiresAt: e.subscription?.expiresAt ?? null,
      });
      if (result.outcome === 'noop' || !result.subscription || !result.plan) return;

      const { subscription: sub, plan } = result;
      logger.info(
        { subscriptionId: sub.id, outcome: result.outcome, transactionId: e.transactionId },
        '[subscription] activated from payment',
      );
      const base = {
        subscriptionId: sub.id,
        ownerId: sub.ownerId,
        planId: plan.id,
        planCode: plan.code,
        tier: plan.tier,
        expiresAt: sub.expiresAt,
        source: sub.source,
        transactionId: e.transactionId,
      };
      if (result.outcome === 'initial') {
        subscriptionEvents.emit('subscription.activated', base);
      } else {
        subscriptionEvents.emit('subscription.renewed', {
          ...base,
          planChanged: result.outcome === 'plan_change',
        });
      }
    } catch (err) {
      logger.error(
        { err, transactionId: e.transactionId },
        '[subscription] activation from payment failed',
      );
    }
  });

  commerceEvents.on('commerce.payment.refunded', async (e) => {
    try {
      const revoked = await subscriptionService.revokeByTransactionId(e.transactionId);
      if (!revoked) return; // not a subscription order, or already revoked

      logger.info(
        { subscriptionId: revoked.id, transactionId: e.transactionId },
        '[subscription] revoked by refund',
      );
      const plan = await prisma.subscriptionPlan.findUniqueOrThrow({
        where: { id: revoked.planId },
      });
      subscriptionEvents.emit('subscription.canceled', {
        subscriptionId: revoked.id,
        ownerId: revoked.ownerId,
        planId: plan.id,
        planCode: plan.code,
        tier: plan.tier,
        expiresAt: revoked.expiresAt,
        source: revoked.source,
        reason: 'refund',
      });
    } catch (err) {
      logger.error(
        { err, transactionId: e.transactionId },
        '[subscription] refund revoke failed',
      );
    }
  });
}
