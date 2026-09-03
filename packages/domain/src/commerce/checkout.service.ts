import { prisma } from '@bb/db';
import { env } from '@bb/common/config/env';
import {
  badRequest,
  notFound,
  BadRequestException,
  ERROR_CODES,
} from '@bb/common/exceptions';
import { computeTotals } from './utils/compute-totals';
import { generateOrderCode } from './utils/generate-order-code';
import { VoucherService } from './voucher.service';
import { attributionService } from '@bb/domain/affiliate/attribution.service';
import { OWNED_FOR_PURCHASE } from './enrollment';
import { isUpgrade } from '../subscription/tier';
import { computeProration } from '../subscription/proration';

export interface StartCheckoutInput {
  memberId: string;
  productId: string;
  voucherCode?: string;
  /** Affiliate code of the link used for THIS purchase (per-purchase commission override). */
  affiliatorCode?: string;
  /**
   * Tracking-link source, snapshotted from the shop's `bb_attr` / `bb_gid`
   * cookies at submit. Frozen on the order and REPORTING ONLY — never an input
   * to commission, which stays `affiliatorCode` + AffiliateVisit. Absent means
   * no source: the column stays NULL and the report renders "direct".
   */
  source?: TrackingSource;
}

export interface TrackingSource {
  guestId?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
}

export interface StartCheckoutResult {
  transactionId: string;
  transactionCode: string;
  itemTotal: number;
  voucherAmount: number;
  /** Unused term credited back on an upgrade; 0 on every other order. */
  prorationCredit: number;
  amount: number;
  expiredAt: Date;
}

export class CheckoutService {
  constructor(private readonly voucherService: VoucherService = new VoucherService()) {}

  async start(input: StartCheckoutInput): Promise<StartCheckoutResult> {
    const product = await prisma.product.findUnique({
      where: { id: input.productId },
      select: { id: true, price: true, isActive: true, status: true },
    });
    if (!product) throw notFound(ERROR_CODES.PRODUCT_NOT_FOUND);
    if (!product.isActive || product.status !== 'active') {
      throw badRequest(ERROR_CODES.PRODUCT_NOT_AVAILABLE);
    }

    // Block paying twice for a course the member still holds — the grant is
    // keyed on (memberId, courseId), so a second purchase would take the money
    // and change nothing. `OWNED_FOR_PURCHASE` scopes the block to RETAIL
    // ownership, which is what keeps it from locking out three cases: a refunded
    // member (their row is cancelled), a member on a free trial (a trial row must
    // not block the purchase it exists to sell), and a member holding the course
    // through a subscription (that purchase is the documented upgrade-to-lifetime
    // path — the payment-success listener clears the marker).
    // Checkout only — the ingest path (IAP/Scalev) cannot refuse a purchase the
    // store has already charged for.
    const owned = await prisma.courseEnrollment.findFirst({
      where: { memberId: input.memberId, ...OWNED_FOR_PURCHASE, course: { productId: product.id } },
      select: { id: true },
    });
    if (owned) throw badRequest(ERROR_CODES.PRODUCT_ALREADY_PURCHASED);

    let prorationCredit = 0;
    // Subscription checkout guard (PRD BE-14). Same plan passes on purpose —
    // that's web renewal-by-repurchase (the reminder emails point here); the
    // activation listener extends the sub on payment success.
    const plan = await prisma.subscriptionPlan.findUnique({
      where: { productId: product.id },
      select: { id: true, seatCount: true },
    });
    if (plan) {
      const activeSub = await prisma.memberSubscription.findFirst({
        where: { ownerId: input.memberId, status: 'ACTIVE' },
        include: { plan: { include: { product: { select: { price: true } } } } },
      });
      if (activeSub && activeSub.planId !== plan.id) {
        prorationCredit = assertTierSwitchAllowed(activeSub, plan, product.price);
      }
      if (!activeSub) {
        // Seated on someone ELSE's ACTIVE sub → resolve that BEFORE paying, not
        // after (the seat-1-left-empty fallback is for the unblockable IAP path).
        // Seats on dead subs (zombies) don't block — consistent with the
        // release-on-demand in claimSeat/createInitial.
        const seatElsewhere = await prisma.subscriptionSeat.findFirst({
          where: {
            memberId: input.memberId,
            subscription: { status: 'ACTIVE', ownerId: { not: input.memberId } },
          },
          select: { id: true },
        });
        if (seatElsewhere) {
          throw new BadRequestException(
            'Kamu masih tergabung di subscription lain — keluar dulu sebelum membeli paket sendiri',
          );
        }
      }
    }

    let voucherId: string | undefined;
    let voucherMeta: {
      type: 'PERCENT' | 'AMOUNT' | 'TRIAL';
      value: number;
      maxAmount?: number | null;
    } | null = null;
    if (input.voucherCode) {
      const check = await this.voucherService.validate(
        input.voucherCode,
        input.productId,
        input.memberId,
      );
      // voucherService.validate() reports an internal English reason — keep it as
      // diagnostics, don't surface it as copy.
      if (!check.valid) {
        throw badRequest(check.errorCode ?? ERROR_CODES.VOUCHER_INVALID, { reason: check.reason });
      }
      voucherId = check.voucherId;
      // maxAmount MUST be threaded through — omitting it silently bypasses the
      // PERCENT cap in computeTotals (over-discount / revenue loss).
      voucherMeta = { type: check.type!, value: check.voucherAmount!, maxAmount: check.maxAmount };
    }

    const totals = computeTotals({
      unitPrice: product.price,
      qty: 1,
      voucher: voucherMeta,
      prorationCredit,
    });

    const attribution = await this.resolveAttribution(input.memberId, input.productId);
    const attributedAffiliatorMemberId = await attributionService.resolveOverrideAffiliatorMemberId(
      input.memberId,
      input.affiliatorCode,
      input.productId, // per-product attribution (B-5): prefer a visit for THIS product
    );

    const code = await generateOrderCode();
    const expiredAt = new Date(Date.now() + env.commerce.transactionExpiryHours * 3600 * 1000);

    const tx = await prisma.commerceTransaction.create({
      data: {
        code,
        memberId: input.memberId,
        productId: input.productId,
        qty: 1,
        itemTotal: totals.itemTotal,
        voucherAmount: totals.voucherAmount,
        voucherCode: input.voucherCode,
        voucherId,
        prorationCredit: totals.prorationCredit,
        amount: totals.amount,
        affiliatorId: attribution.affiliatorId,
        programId: attribution.programId,
        attributedAffiliatorMemberId,
        // Frozen at creation, never updated: the shop cookie is last-touch, so
        // reading the source back through shop_visits would retro-move a paid
        // order onto whatever campaign the buyer clicked next.
        guestId: input.source?.guestId,
        utmSource: input.source?.utmSource,
        utmMedium: input.source?.utmMedium,
        utmCampaign: input.source?.utmCampaign,
        utmContent: input.source?.utmContent,
        utmTerm: input.source?.utmTerm,
        status: 'PENDING',
        expiredAt,
      },
      select: { id: true, code: true },
    });

    return {
      transactionId: tx.id,
      transactionCode: tx.code,
      itemTotal: totals.itemTotal,
      voucherAmount: totals.voucherAmount,
      prorationCredit: totals.prorationCredit,
      amount: totals.amount,
      expiredAt,
    };
  }

  /**
   * Last-touch attribution from AffiliateVisit within 30-day cookie window.
   * Falls back to {null, null} if no visit found.
   */
  private async resolveAttribution(
    memberId: string,
    productId: string,
  ): Promise<{ affiliatorId: string | null; programId: string | null }> {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const visit = await prisma.affiliateVisit.findFirst({
      where: {
        memberId,
        createdAt: { gte: since },
        program: { productId },
      },
      orderBy: { createdAt: 'desc' },
      select: { affiliatorMemberId: true, programId: true },
    });
    if (!visit || !visit.programId)
      return { affiliatorId: null, programId: visit?.programId ?? null };

    const affiliator = await prisma.memberAffiliator.findUnique({
      where: {
        memberId_programId: {
          memberId: visit.affiliatorMemberId,
          programId: visit.programId,
        },
      },
      select: { id: true },
    });
    return {
      affiliatorId: affiliator?.id ?? null,
      programId: visit.programId,
    };
  }
}

/**
 * Which tier switches web checkout will sell, and at what price.
 *
 * **Upgrade** is sold immediately, prorated: the member gets the bigger plan and
 * the seats today, and pays the new price minus whatever their current term is
 * still worth. Same deal Apple gives on iOS, deliberately.
 *
 * **Downgrade** is only sold once the running term has actually ended (the grace
 * window). Selling it earlier would apply the smaller plan on payment and strip
 * the member of seats and access they already paid for — the exact failure the
 * scheduled-change flow exists to prevent. Before that date the answer is
 * "declare it, we will apply it then", which is what `POST /subscription/pending`
 * is for. It also has to have BEEN declared: an undeclared downgrade means the
 * member never saw the "who keeps a seat" step.
 *
 * Returns the proration credit to apply (0 for a downgrade).
 */
function assertTierSwitchAllowed(
  sub: {
    planId: string;
    expiresAt: Date;
    pendingPlanId: string | null;
    plan: { seatCount: number; periodMonths: number; product: { price: number } };
  },
  target: { id: string; seatCount: number },
  targetPrice: number,
): number {
  const from = { seatCount: sub.plan.seatCount, price: sub.plan.product.price };
  const to = { seatCount: target.seatCount, price: targetPrice };
  const now = new Date();

  if (isUpgrade(from, to)) {
    return computeProration({
      oldPrice: sub.plan.product.price,
      newPrice: targetPrice,
      expiresAt: sub.expiresAt,
      periodMonths: sub.plan.periodMonths,
      now,
    }).credit;
  }

  if (sub.pendingPlanId !== target.id) {
    throw new BadRequestException(
      'Jadwalkan dulu penurunan paket sebelum membayar — akses paket sekarang masih berjalan',
    );
  }
  if (now < sub.expiresAt) {
    throw new BadRequestException(
      'Paket sekarang masih berjalan — pembayaran paket baru bisa dilakukan setelah masa aktif berakhir',
    );
  }
  return 0;
}
