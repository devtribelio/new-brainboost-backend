import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { commerceEvents } from '@bb/common/events/commerce-events';
import { NotificationProducer } from '../notification.producer';
import { ActionLabel, NotifGroup } from '../action-labels';
import { loadTrialGrant, trialExpiresAt, formatDateWib } from '@bb/domain/commerce/trial';

const producer = new NotificationProducer();

export function registerCommerceNotificationListener(): void {
  commerceEvents.on('commerce.payment.success', async (e) => {
    try {
      const product = await prisma.product.findUnique({
        where: { id: e.productId },
        select: { title: true, code: true },
      });
      const named = product ? product.title : null;

      // A trial is not a payment: the member was not charged, and the one fact
      // worth pushing is the date access stops. Loaded here rather than taken
      // from the event — see `commerce/trial.ts` for why.
      const trial = e.voucherId ? await loadTrialGrant(e.voucherId) : null;
      const trialEndsAt = trial ? trialExpiresAt(new Date(), trial.trialDays) : null;

      let type: ActionLabel;
      let title: string;
      let body: string;
      let dedupePrefix: string;
      if (trialEndsAt) {
        type = ActionLabel.TrialStarted;
        title = 'Uji coba kamu aktif';
        // The end date goes in the body, not the title: Android truncates titles
        // around 40 chars, and this date is the only new information here.
        body = named
          ? `Akses ${named} terbuka sampai ${formatDateWib(trialEndsAt)}.`
          : `Akses kamu terbuka sampai ${formatDateWib(trialEndsAt)}.`;
        dedupePrefix = 'trialStarted';
      } else if (e.isRenewal) {
        type = ActionLabel.SubscriptionRenewed;
        title = 'Langganan diperpanjang';
        body = named ? `Langganan ${named} kamu diperpanjang.` : 'Langganan kamu diperpanjang.';
        dedupePrefix = 'subscriptionRenewed';
      } else {
        type = ActionLabel.PaymentSuccess;
        title = 'Pembayaran berhasil';
        body = named ? `Pesanan ${named} kamu sudah dibayar.` : 'Pesanan kamu sudah dibayar.';
        dedupePrefix = 'paymentSuccess';
      }

      await producer.createForMember({
        memberId: e.memberId,
        type,
        notifGroup: NotifGroup.General,
        title,
        body,
        payload: {
          refTable: 'commerce_payment',
          refId: e.paymentId,
          transactionId: e.transactionId,
          productId: e.productId,
          productCode: product?.code ?? null,
          amount: e.amount,
          trialEndsAt: trialEndsAt ? trialEndsAt.toISOString() : null,
        },
        dedupeKey: `${dedupePrefix}:${e.paymentId}:${e.memberId}`,
      });
    } catch (err) {
      logger.error({ err, paymentId: e.paymentId }, '[notification] commerce listener failed');
    }
  });

  commerceEvents.on('commerce.payment.refunded', async (e) => {
    try {
      const product = e.productId
        ? await prisma.product.findUnique({ where: { id: e.productId }, select: { title: true, code: true } })
        : null;
      const body = product
        ? `Pembelian ${product.title} kamu telah di-refund dan aksesnya dicabut.`
        : 'Pembelian kamu telah di-refund dan aksesnya dicabut.';

      await producer.createForMember({
        memberId: e.memberId,
        type: ActionLabel.PaymentRefunded,
        notifGroup: NotifGroup.General,
        title: 'Pembelian di-refund',
        body,
        payload: {
          refTable: 'commerce_payment',
          refId: e.paymentId ?? null,
          transactionId: e.transactionId,
          productId: e.productId ?? null,
          productCode: product?.code ?? null,
        },
        dedupeKey: `paymentRefunded:${e.transactionId}:${e.memberId}`,
      });
    } catch (err) {
      logger.error({ err, transactionId: e.transactionId }, '[notification] commerce refund listener failed');
    }
  });
}
