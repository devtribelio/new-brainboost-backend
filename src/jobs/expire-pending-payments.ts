import { prisma } from '@bb/db';
import { logger } from '@/config/logger';
import { commerceEvents } from '@/common/events/commerce-events';

/**
 * Background job: scan PENDING payments past expiry, flip to EXPIRED.
 * Designed to be called from external scheduler (cron / Postgres LISTEN).
 */
export async function expirePendingPayments(now: Date = new Date()): Promise<{ expired: number }> {
  const overdue = await prisma.commercePayment.findMany({
    where: { status: 'PENDING', expiredAt: { not: null, lt: now } },
    select: { id: true, transactionId: true },
  });

  let expired = 0;
  for (const p of overdue) {
    try {
      await prisma.$transaction(async (txdb) => {
        await txdb.commercePayment.update({
          where: { id: p.id },
          data: { status: 'EXPIRED', updatedAt: now },
        });
        await txdb.commercePaymentEvent.create({
          data: {
            paymentId: p.id,
            source: 'poll',
            fromStatus: 'PENDING',
            toStatus: 'EXPIRED',
          },
        });
        await txdb.commerceTransaction.update({
          where: { id: p.transactionId },
          data: { status: 'EXPIRED' },
        });
      });
      commerceEvents.emit('commerce.payment.expired', {
        paymentId: p.id,
        transactionId: p.transactionId,
      });
      expired++;
    } catch (err) {
      logger.error({ err, paymentId: p.id }, '[expire-cron] failed to expire payment');
    }
  }

  if (expired > 0) {
    logger.info({ expired, total: overdue.length }, '[expire-cron] swept expired payments');
  }
  return { expired };
}
