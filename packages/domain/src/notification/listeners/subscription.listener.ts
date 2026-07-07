import { logger } from '@bb/common/config/logger';
import { subscriptionEvents } from '@bb/common/events/subscription-events';
import { NotificationProducer } from '../notification.producer';
import { ActionLabel, NotifGroup } from '../action-labels';

const producer = new NotificationProducer();

/**
 * In-app/push notifications for the subscription lifecycle (PRD BE-17).
 * The commerce payment-success notification skips plan-backed products, so
 * these are the ONLY subscription messages a member sees (no doubles).
 * canceled(reason=refund) is deliberately ignored — the commerce refund
 * notification already covers that money-side message.
 */
export function registerSubscriptionNotificationListener(): void {
  subscriptionEvents.on('subscription.activated', async (e) => {
    try {
      await producer.createForMember({
        memberId: e.ownerId,
        type: ActionLabel.SubscriptionActivated,
        notifGroup: NotifGroup.General,
        title: 'Langganan aktif',
        body: `Langganan ${e.tier} kamu aktif. Selamat menikmati akses penuh semua program!`,
        payload: subPayload(e),
        dedupeKey: `subscriptionActivated:${e.subscriptionId}:${e.transactionId ?? 'grant'}`,
      });
    } catch (err) {
      logger.error({ err, subscriptionId: e.subscriptionId }, '[notification] sub activated failed');
    }
  });

  subscriptionEvents.on('subscription.renewed', async (e) => {
    try {
      await producer.createForMember({
        memberId: e.ownerId,
        type: ActionLabel.SubscriptionRenewed,
        notifGroup: NotifGroup.General,
        title: 'Langganan diperpanjang',
        body: `Langganan ${e.tier} kamu diperpanjang. Terima kasih!`,
        payload: subPayload(e),
        dedupeKey: `subscriptionRenewed:${e.subscriptionId}:${e.transactionId ?? e.expiresAt.toISOString()}`,
      });
    } catch (err) {
      logger.error({ err, subscriptionId: e.subscriptionId }, '[notification] sub renewed failed');
    }
  });

  subscriptionEvents.on('subscription.expired', async (e) => {
    try {
      await producer.createForMember({
        memberId: e.ownerId,
        type: ActionLabel.SubscriptionExpired,
        notifGroup: NotifGroup.General,
        title: 'Langganan berakhir',
        body: 'Langganan kamu telah berakhir. Perpanjang untuk mengakses kembali semua program.',
        payload: subPayload(e),
        dedupeKey: `subscriptionExpired:${e.subscriptionId}:${e.expiresAt.toISOString()}`,
      });
    } catch (err) {
      logger.error({ err, subscriptionId: e.subscriptionId }, '[notification] sub expired failed');
    }
  });

  subscriptionEvents.on('subscription.canceled', async (e) => {
    if (e.reason === 'refund') return; // commerce refund notification covers it
    try {
      await producer.createForMember({
        memberId: e.ownerId,
        type: ActionLabel.SubscriptionCanceled,
        notifGroup: NotifGroup.General,
        title: 'Perpanjangan otomatis dimatikan',
        body: 'Langganan kamu tidak akan diperpanjang otomatis — akses tetap aktif sampai tanggal berakhir.',
        payload: subPayload(e),
        dedupeKey: `subscriptionCanceled:${e.subscriptionId}:${e.expiresAt.toISOString()}`,
      });
    } catch (err) {
      logger.error({ err, subscriptionId: e.subscriptionId }, '[notification] sub canceled failed');
    }
  });
}

function subPayload(e: {
  subscriptionId: string;
  planId: string;
  planCode: string;
  tier: string;
  expiresAt: Date;
}) {
  return {
    refTable: 'member_subscriptions',
    refId: e.subscriptionId,
    planId: e.planId,
    planCode: e.planCode,
    tier: e.tier,
    expiresAt: e.expiresAt.toISOString(),
  };
}
