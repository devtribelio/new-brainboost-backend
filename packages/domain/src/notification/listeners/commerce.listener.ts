import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { commerceEvents } from '@bb/common/events/commerce-events';
import { NotificationProducer } from '../notification.producer';
import { ActionLabel, NotifGroup } from '../action-labels';

const producer = new NotificationProducer();

export function registerCommerceNotificationListener(): void {
  commerceEvents.on('commerce.payment.success', async (e) => {
    try {
      const product = await prisma.product.findUnique({
        where: { id: e.productId },
        select: { title: true, code: true },
      });
      const named = product ? product.title : null;

      const type = e.isRenewal ? ActionLabel.SubscriptionRenewed : ActionLabel.PaymentSuccess;
      const title = e.isRenewal ? 'Langganan diperpanjang' : 'Pembayaran berhasil';
      const body = e.isRenewal
        ? named
          ? `Langganan ${named} kamu diperpanjang.`
          : 'Langganan kamu diperpanjang.'
        : named
          ? `Pesanan ${named} kamu sudah dibayar.`
          : 'Pesanan kamu sudah dibayar.';
      const dedupePrefix = e.isRenewal ? 'subscriptionRenewed' : 'paymentSuccess';

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
