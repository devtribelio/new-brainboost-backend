import { logger } from '@bb/common/config/logger';
import { subscriptionEvents } from '@bb/common/events/subscription-events';
import { NotificationProducer } from '../notification.producer';
import { ActionLabel, NotifGroup } from '../action-labels';
import { formatDateWib } from '../../commerce/trial';

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

  subscriptionEvents.on('subscription.pending_change', async (e) => {
    try {
      const mustEvict = e.claimedSeats > e.pendingSeatCount;
      await producer.createForMember({
        memberId: e.ownerId,
        type: ActionLabel.SubscriptionChangeScheduled,
        notifGroup: NotifGroup.General,
        title: `Paket berubah ke ${e.pendingTier}`,
        // The date carries the reassurance ("nothing changes today"), so it goes
        // in the body — Android truncates titles at ~40 chars.
        body: mustEvict
          ? `Mulai ${formatDateWib(e.effectiveAt)} paket kamu jadi ${e.pendingTier} (${e.pendingSeatCount} seat). Pilih siapa yang tetap dapat akses sebelum tanggal itu.`
          : `Paket ${e.tier} kamu aktif sampai ${formatDateWib(e.effectiveAt)}, lalu berubah jadi ${e.pendingTier}.`,
        payload: { ...subPayload(e), pendingPlanCode: e.pendingPlanCode, mustEvict },
        // Keyed on the target plan: re-declaring a DIFFERENT downgrade is worth
        // telling them about, re-declaring the same one is not.
        dedupeKey: `subscriptionChangeScheduled:${e.subscriptionId}:${e.pendingPlanId}`,
      });
    } catch (err) {
      logger.error({ err, subscriptionId: e.subscriptionId }, '[notification] pending change failed');
    }
  });

  subscriptionEvents.on('subscription.plan_changed', async (e) => {
    if (!e.evictedMemberIds.length) return; // nothing anyone needs to be told
    try {
      // The owner scheduled this, but that may have been months ago and they may
      // never have picked anyone. Without this they only see a routine renewal
      // receipt while members quietly lose access — and the first they hear of it
      // is those members asking why they are locked out.
      await producer.createForMember({
        memberId: e.ownerId,
        type: ActionLabel.SubscriptionSeatRemoved,
        notifGroup: NotifGroup.General,
        title: `Paket kamu sekarang ${e.tier}`,
        body: `${e.evictedMemberIds.length} anggota keluar dari langganan karena ${e.tier} punya lebih sedikit seat. Kamu bisa mengundang lagi kapan saja selama seat masih kosong.`,
        payload: subPayload(e),
        dedupeKey: `subscriptionSeatsCut:${e.subscriptionId}:${e.expiresAt.toISOString()}`,
      });
      await producer.createForMany(
        e.evictedMemberIds,
        {
          type: ActionLabel.SubscriptionSeatRemoved,
          notifGroup: NotifGroup.General,
          title: 'Akses langganan berakhir',
          body: `Paket ${e.previousTier} yang kamu ikuti berubah jadi ${e.tier}, dan seat kamu tidak termasuk lagi.`,
          payload: subPayload(e),
        },
        `subscriptionSeatRemoved:${e.subscriptionId}:${e.expiresAt.toISOString()}`,
      );
    } catch (err) {
      logger.error({ err, subscriptionId: e.subscriptionId }, '[notification] seat removed failed');
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
