import { logger } from '@bb/common/config/logger';
import { subscriptionEvents } from '@bb/common/events/subscription-events';
import { enqueueComms } from '@bb/common/services/comms-outbox';

/**
 * Outbound email producer for the subscription lifecycle (PRD BE-18):
 * activation + renewal receipts. bb-comms renders by refId =
 * member_subscriptions.id (joins plan + owner); the 3 subscription templates
 * shipped in BB-111.
 *
 * A TIER CHANGE is the one thing that lookup cannot describe on its own: by the
 * time bb-comms reads the row, `plan_id` already points at the new plan and the
 * old one is recorded nowhere it can reach. So the plan-change path carries the
 * missing facts in the message `payload` instead. It stays type
 * `SubscriptionRenewed` on purpose — an unknown message type goes straight to
 * bb-comms' DLQ, while an unknown payload FIELD is simply ignored, so this
 * cannot break a bb-comms that has not been redeployed yet.
 *
 * Best-effort + post-commit, same contract as the commerce receipts. The
 * commerce CoursePaymentSuccess listener skips plan-backed products, so a
 * subscription purchase produces exactly one email.
 */
export function registerSubscriptionEmailListeners(): void {
  subscriptionEvents.on('subscription.activated', async (e) => {
    try {
      await enqueueComms({
        type: 'SubscriptionActivated',
        channel: 'email',
        priority: 'normal',
        refId: e.subscriptionId,
      });
    } catch (err) {
      logger.error(
        { err, subscriptionId: e.subscriptionId },
        '[comms-email] failed to enqueue SubscriptionActivated',
      );
    }
  });

  subscriptionEvents.on('subscription.renewed', async (e) => {
    // A tier change fires renewed AND plan_changed. Let the plan_changed
    // handler send the receipt — it is the only one that knows what the member
    // came from, and two receipts for one payment is worse than a late one.
    if (e.planChanged) return;
    try {
      await enqueueComms({
        type: 'SubscriptionRenewed',
        channel: 'email',
        priority: 'normal',
        refId: e.subscriptionId,
      });
    } catch (err) {
      logger.error(
        { err, subscriptionId: e.subscriptionId },
        '[comms-email] failed to enqueue SubscriptionRenewed',
      );
    }
  });

  subscriptionEvents.on('subscription.plan_changed', async (e) => {
    try {
      await enqueueComms({
        type: 'SubscriptionRenewed',
        channel: 'email',
        priority: 'normal',
        refId: e.subscriptionId,
        payload: {
          previousTier: e.previousTier,
          previousPlanCode: e.previousPlanCode,
          // Drives one extra line: a receipt that says nothing about the people
          // who just lost access reads as if nothing happened to them.
          evictedCount: e.evictedMemberIds.length,
        },
      });
    } catch (err) {
      logger.error(
        { err, subscriptionId: e.subscriptionId },
        '[comms-email] failed to enqueue SubscriptionRenewed (tier change)',
      );
    }
  });
}
