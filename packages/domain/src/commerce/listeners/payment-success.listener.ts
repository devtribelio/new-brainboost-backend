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
      // Commission base = net we actually take home (when channel exposes it),
      // not the gross customer paid. Required so affiliator rate × IAP equals
      // rate × web for the SAME course — Brainboost marks up IAP price to
      // offset Apple's cut, and using gross would let the markup leak through
      // as bonus affiliator commission. `+ voucherAmount` reconstructs the
      // pre-voucher base so `computeAmount` can subtract it again (legacy
      // shape). When acceptedAmount is absent, falls back to gross (web /
      // voucher bypass behavior unchanged).
      const commissionBase = e.acceptedAmount ?? e.amount;
      await affiliatorService
        .commitCommissionsForPayment({
          paymentId: e.paymentId,
          productId: e.productId,
          productPrice: commissionBase + e.voucherAmount,
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
  // createMany + skipDuplicates: idempotent without throwing on the
  // (memberId, courseId) unique. `create`+catch worked but Prisma still logs
  // the swallowed P2002 at error level (prisma:error noise on every re-purchase
  // / redelivered IAP event) — skipDuplicates avoids the throw entirely.
  await prisma.courseEnrollment.createMany({
    data: [{ memberId, courseId: product.course.id, dateStart: new Date() }],
    skipDuplicates: true,
  });
}
