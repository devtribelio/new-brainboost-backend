import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { commerceEvents } from '@bb/common/events/commerce-events';
import { AffiliatorService } from '@bb/domain/affiliate/affiliator.service';
import { VoucherService } from '../voucher.service';

const affiliatorService = new AffiliatorService();
const voucherService = new VoucherService();

/**
 * Side effects of a successful commerce payment.
 * Each effect is idempotent so re-emits (redelivered webhook) are safe.
 */
export function registerCommerceListeners(): void {
  commerceEvents.on('commerce.payment.success', async (e) => {
    logger.info(
      { paymentId: e.paymentId, transactionId: e.transactionId },
      '[commerce] payment success — running side effects',
    );

    // 1. Grant course enrollment (for course products)
    await grantCourseEnrollment(e.memberId, e.productId).catch((err) =>
      logger.error({ err, paymentId: e.paymentId }, '[commerce] enrollment grant failed'),
    );

    // 2. Redeem voucher (atomic used++ on quota)
    if (e.voucherId) {
      await voucherService
        .redeem(e.voucherId)
        .catch((err) =>
          logger.error({ err, voucherId: e.voucherId }, '[commerce] voucher redeem failed'),
        );
    }

    // 3. Commit affiliate commissions (idempotent via unique constraint).
    //    Skip when the channel is not affiliate-eligible (e.g. an ingested channel with
    //    triggersAffiliate=false). `undefined` (web/native) = eligible.
    if (e.affiliateEligible !== false) {
      await affiliatorService
        .commitCommissionsForPayment({
          paymentId: e.paymentId,
          productId: e.productId,
          productPrice: e.amount + e.voucherAmount,
          voucherAmount: e.voucherAmount,
          buyerMemberId: e.memberId,
          programId: e.programId ?? null,
          overrideAffiliatorMemberId: e.attributedAffiliatorMemberId ?? null,
        })
        .catch((err) =>
          logger.error({ err, paymentId: e.paymentId }, '[commerce] commission commit failed'),
        );
    }
  });
}

async function grantCourseEnrollment(memberId: string, productId: string): Promise<void> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, type: true, course: { select: { id: true } } },
  });
  if (!product?.course || product.type !== 'course') return;
  try {
    await prisma.courseEnrollment.create({
      data: {
        memberId,
        courseId: product.course.id,
        dateStart: new Date(),
      },
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== 'P2002') throw e;
    // unique (memberId, courseId) — already enrolled, idempotent skip
  }
}
