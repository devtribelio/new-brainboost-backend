import { logger } from '@bb/common/config/logger';
import { subscriptionEvents } from '@bb/common/events/subscription-events';
import { enqueueComms } from '@bb/common/services/comms-outbox';

/**
 * Outbound email producer for the subscription lifecycle (PRD BE-18):
 * activation + renewal receipts. bb-comms renders by refId =
 * member_subscriptions.id (joins plan + owner) — the 3 subscription templates
 * (these two + SubscriptionRenewalReminder used by the BE-15 job) are an
 * EXTERNAL dependency in the bb-comms repo; until they ship, these outbox rows
 * fail at bb-comms (see docs/specs/subscription-progress.md).
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
}
