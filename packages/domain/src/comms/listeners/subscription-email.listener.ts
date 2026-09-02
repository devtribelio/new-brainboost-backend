import { logger } from '@bb/common/config/logger';
import { subscriptionEvents } from '@bb/common/events/subscription-events';
import { prisma } from '@bb/db';
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

  // Losing a seat, all three ways it happens. One message type discriminated by
  // `reason` rather than three types: to the person receiving it these are the
  // same event — the seat they were using is gone — and the copy has to stay
  // parallel anyway. Addressed by `recipient`, since bb-comms resolves refId to
  // the subscription's OWNER and these go to a member of it.
  subscriptionEvents.on('subscription.seat_removed', async (e) => {
    await enqueueSeatEnded([e.memberId], e.subscriptionId, 'removed');
  });

  subscriptionEvents.on('subscription.plan_changed', async (e) => {
    if (e.evictedMemberIds.length) {
      await enqueueSeatEnded(e.evictedMemberIds, e.subscriptionId, 'tier_change');
    }
  });

  subscriptionEvents.on('subscription.expired', async (e) => {
    if (e.seatMemberIds.length) {
      await enqueueSeatEnded(e.seatMemberIds, e.subscriptionId, 'expired');
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

/**
 * Look the members up rather than threading emails through the events: an email
 * on an event payload goes stale the moment someone changes theirs, and every
 * emitter would have to remember to include it.
 *
 * A member with no email is skipped silently — they still got the push, and
 * every one of these paths already told them there.
 */
async function enqueueSeatEnded(
  memberIds: string[],
  subscriptionId: string,
  reason: 'removed' | 'tier_change' | 'expired',
): Promise<void> {
  try {
    const members = await prisma.member.findMany({
      where: { id: { in: memberIds }, email: { not: null } },
      select: { email: true, fullName: true },
    });
    for (const m of members) {
      await enqueueComms({
        type: 'SubscriptionSeatEnded',
        channel: 'email',
        priority: 'normal',
        refId: subscriptionId, // bb-comms reads the plan/tier from here
        recipient: m.email as string, // …but sends to the seat member, not the owner
        payload: { reason, memberName: m.fullName ?? '' },
      });
    }
  } catch (err) {
    logger.error(
      { err, subscriptionId, reason },
      '[comms-email] failed to enqueue SubscriptionSeatEnded',
    );
  }
}
