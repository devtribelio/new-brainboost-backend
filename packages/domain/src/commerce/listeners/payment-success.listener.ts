import { prisma } from '@bb/db';
import type { Prisma } from '@prisma/client';
import { logger } from '@bb/common/config/logger';
import { commerceEvents } from '@bb/common/events/commerce-events';
import { AffiliatorService } from '@bb/domain/affiliate/affiliator.service';
import { VoucherService } from '../voucher.service';
import { loadTrialGrant, trialExpiresAt, type TrialGrant } from '../trial';

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

    // A TRIAL voucher turns this order into a time-boxed grant instead of a
    // permanent one, so the voucher has to be read BEFORE the enrollment is
    // written. Loaded here rather than carried on the event: the event is emitted
    // from four channels (checkout bypass, Xendit webhook, RC, ingest) and a new
    // required field would have to be threaded through every one of them.
    const trial = e.voucherId ? await loadTrialGrant(e.voucherId) : null;

    // 1. Grant course enrollment (for course products)
    await grantCourseEnrollment(e.memberId, e.productId, trial).catch((err) =>
      logger.error({ err, paymentId: e.paymentId }, '[commerce] enrollment grant failed'),
    );

    // 2. Redeem voucher (atomic used++ on quota, idempotent per order so a
    //    redelivered webhook can't double-count — keyed on transactionId)
    if (e.voucherId) {
      await voucherService
        .redeem(e.voucherId, e.transactionId, e.paymentId)
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
      //
      // PPN is stripped first — tax is money forwarded to the state, not
      // revenue, so an affiliator must earn the same on a course whether the
      // rate is 0 or 11. `taxAmount` is always expressed on the same figure
      // the base comes from: on the web path it is the tax added on top of
      // `amount`; on IAP the ingest kernel books it as rate × `acceptedAmount`
      // (Apple's payout). So one flat subtraction is right for both. 0 (or
      // absent) on every channel that books no tax.
      const commissionBase = (e.acceptedAmount ?? e.amount) - (e.taxAmount ?? 0);
      await affiliatorService
        .commitCommissionsForPayment({
          paymentId: e.paymentId,
          productId: e.productId,
          productPrice: commissionBase + e.voucherAmount,
          voucherAmount: e.voucherAmount,
          buyerMemberId: e.memberId,
          programId: e.programId ?? null,
          overrideAffiliatorMemberId: e.attributedAffiliatorMemberId ?? null,
          channel: e.channel ?? null,
        })
        .catch((err) =>
          logger.error({ err, paymentId: e.paymentId }, '[commerce] commission commit failed'),
        );
    }
  });
}

async function grantCourseEnrollment(
  memberId: string,
  productId: string,
  trial: TrialGrant | null = null,
): Promise<void> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, type: true, course: { select: { id: true } } },
  });
  // A linked `course` row is the single proof a product is enrollable — covers
  // both `course` and `mini_course` (and any future course-backed type). The old
  // `type === 'course'` gate silently dropped mini_course purchases: commission
  // committed but enrollment never granted (xendit + revenuecat alike, since both
  // converge on this event). Keying on `product.course` closes that leak.
  if (!product?.course) return;
  const now = new Date();
  // A trial grant is time-boxed and marked; a paid grant is permanent and clears
  // any trial marker left by the run it converts (expired_date must go with it —
  // a stale date on an unmarked row is harmless today but is exactly the kind of
  // thing a future gate would read).
  const grant = trial
    ? { viaVoucherId: trial.voucherId, expiredDate: trialExpiresAt(now, trial.trialDays) }
    : { viaVoucherId: null, expiredDate: null };

  // A refund leaves the enrollment behind as a cancelled row, and a trial leaves
  // a live-but-expiring one, so plain createMany+skipDuplicates would silently
  // skip both: the member pays and stays revoked / stays on the trial clock.
  // Revive-or-convert first, then insert only when there was nothing to update.
  //
  // The `where` is what preserves idempotency: it matches ONLY cancelled rows and
  // trial rows, so a redelivered event for a live paid enrollment updates 0 rows
  // instead of resetting a member's progress to zero. For a trial it also excludes
  // its own voucher, so a redelivered trial event cannot extend `expired_date`.
  //
  // B2B seats (`viaB2bGrantId` set) are deliberately NOT in this set: converting
  // one must keep the member's progress, so it is handled separately below.
  const target: Prisma.CourseEnrollmentWhereInput = {
    memberId,
    courseId: product.course.id,
    viaB2bGrantId: null,
    OR: [
      { isCanceled: true },
      trial ? { viaVoucherId: { not: null, notIn: [trial.voucherId] } } : { viaVoucherId: { not: null } },
    ],
  };
  const revived = await prisma.courseEnrollment.updateMany({
    where: target,
    // Re-purchase restarts the course: progress, completion and any certificate
    // earned on the refunded (or trial) run are cleared, so `progress` can never
    // disagree with a certificate that is no longer backed by a purchase. The
    // member's listening history (`listening_session`) is a separate log and survives.
    data: {
      isCanceled: false,
      cancelationReason: null,
      canceledAt: null,
      progress: 0,
      dateStart: now,
      dateEnd: null,
      certificateCode: null,
      certificateCreated: null,
      ...grant,
    },
  });
  // B2B seat → personal purchase. The row becomes permanent and leaves the B2B
  // backend's reach (marker cleared, so a later company revoke never touches it),
  // but `progress` / certificate / dateStart stay: the member keeps what they
  // earned on the company seat (PRD b2b-db-consolidation, decision 2026-10-01).
  // Only a PAID grant converts — a trial on top of a company seat is a no-op.
  let converted = 0;
  if (!trial) {
    const res = await prisma.courseEnrollment.updateMany({
      where: { memberId, courseId: product.course.id, viaB2bGrantId: { not: null } },
      data: {
        viaB2bGrantId: null,
        viaVoucherId: null,
        expiredDate: null,
        isCanceled: false,
        cancelationReason: null,
        canceledAt: null,
      },
    });
    converted = res.count;
  }
  if (revived.count + converted === 0) {
    await prisma.courseEnrollment.createMany({
      data: [{ memberId, courseId: product.course.id, dateStart: now, ...grant }],
      skipDuplicates: true,
    });
  }
}
