import { prisma } from '@bb/db';
import { logger } from '@/config/logger';
import { commerceEvents } from '@/common/events/commerce-events';
import { NotificationProducer } from '../notification.producer';
import { ActionLabel, NotifGroup } from '../action-labels';

const producer = new NotificationProducer();

export function registerCommerceNotificationListener(): void {
  commerceEvents.on('commerce.payment.success', async (e) => {
    try {
      const product = await prisma.product.findUnique({
        where: { id: e.productId },
        select: { title: true },
      });
      const title = 'Payment successful';
      const body = product ? `Your order for ${product.title} is paid.` : 'Your order is paid.';

      await producer.createForMember({
        memberId: e.memberId,
        type: ActionLabel.PaymentSuccess,
        notifGroup: NotifGroup.General,
        title,
        body,
        payload: {
          refTable: 'commerce_payment',
          refId: e.paymentId,
          transactionId: e.transactionId,
          productId: e.productId,
          amount: e.amount,
        },
        dedupeKey: `paymentSuccess:${e.paymentId}:${e.memberId}`,
      });
    } catch (err) {
      logger.error({ err, paymentId: e.paymentId }, '[notification] commerce listener failed');
    }
  });
}
