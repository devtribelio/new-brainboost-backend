import { prisma } from '@bb/db';
import { env } from '@bb/common/config/env';
import { BadRequestException, NotFoundException } from '@bb/common/exceptions';
import { computeTotals } from './utils/compute-totals';
import { generateOrderCode } from './utils/generate-order-code';
import { VoucherService } from './voucher.service';
import { attributionService } from '@bb/domain/affiliate/attribution.service';

export interface StartCheckoutInput {
  memberId: string;
  productId: string;
  voucherCode?: string;
  /** Affiliate code of the link used for THIS purchase (per-purchase commission override). */
  affiliatorCode?: string;
}

export interface StartCheckoutResult {
  transactionId: string;
  transactionCode: string;
  itemTotal: number;
  voucherAmount: number;
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
    if (!product) throw new NotFoundException('Product not found');
    if (!product.isActive || product.status !== 'active') {
      throw new BadRequestException('Product not available');
    }

    // Subscription checkout guard (PRD BE-14). Same plan passes on purpose —
    // that's web renewal-by-repurchase (the reminder emails point here); the
    // activation listener extends the sub on payment success. Tier switches on
    // web are Phase 2 (the only sanctioned switch path is RC PRODUCT_CHANGE).
    const plan = await prisma.subscriptionPlan.findUnique({
      where: { productId: product.id },
      select: { id: true },
    });
    if (plan) {
      const activeSub = await prisma.memberSubscription.findFirst({
        where: { ownerId: input.memberId, status: 'ACTIVE' },
        select: { planId: true },
      });
      if (activeSub && activeSub.planId !== plan.id) {
        throw new BadRequestException(
          'Kamu masih punya subscription aktif di paket lain — upgrade/downgrade belum tersedia',
        );
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
    let voucherMeta:
      | { type: 'PERCENT' | 'AMOUNT'; value: number; maxAmount?: number | null }
      | null = null;
    if (input.voucherCode) {
      const check = await this.voucherService.validate(input.voucherCode, input.productId);
      if (!check.valid) throw new BadRequestException(check.reason ?? 'Voucher invalid');
      voucherId = check.voucherId;
      // maxAmount MUST be threaded through — omitting it silently bypasses the
      // PERCENT cap in computeTotals (over-discount / revenue loss).
      voucherMeta = { type: check.type!, value: check.voucherAmount!, maxAmount: check.maxAmount };
    }

    const totals = computeTotals({
      unitPrice: product.price,
      qty: 1,
      voucher: voucherMeta,
    });

    const attribution = await this.resolveAttribution(input.memberId, input.productId);
    const attributedAffiliatorMemberId = await attributionService.resolveOverrideAffiliatorMemberId(
      input.memberId,
      input.affiliatorCode,
      input.productId, // per-product attribution (B-5): prefer a visit for THIS product
    );

    const code = await generateOrderCode();
    const expiredAt = new Date(
      Date.now() + env.commerce.transactionExpiryHours * 3600 * 1000,
    );

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
        amount: totals.amount,
        affiliatorId: attribution.affiliatorId,
        programId: attribution.programId,
        attributedAffiliatorMemberId,
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
    if (!visit || !visit.programId) return { affiliatorId: null, programId: visit?.programId ?? null };

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
