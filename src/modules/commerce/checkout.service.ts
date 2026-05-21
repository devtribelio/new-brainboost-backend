import { prisma } from '@/config/prisma';
import { env } from '@/config/env';
import { BadRequestException, NotFoundException } from '@/common/exceptions';
import { computeTotals } from './utils/compute-totals';
import { generateOrderCode } from './utils/generate-order-code';
import { VoucherService } from './voucher.service';

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

    let voucherId: string | undefined;
    let voucherMeta:
      | { type: 'PERCENT' | 'AMOUNT'; value: number; maxAmount?: number | null }
      | null = null;
    if (input.voucherCode) {
      const check = await this.voucherService.validate(input.voucherCode, input.productId);
      if (!check.valid) throw new BadRequestException(check.reason ?? 'Voucher invalid');
      voucherId = check.voucherId;
      voucherMeta = { type: check.type!, value: check.voucherAmount! };
    }

    const totals = computeTotals({
      unitPrice: product.price,
      qty: 1,
      voucher: voucherMeta,
    });

    const attribution = await this.resolveAttribution(input.memberId, input.productId);
    const attributedAffiliatorMemberId = await this.resolveOverrideAffiliator(
      input.affiliatorCode,
      input.memberId,
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
   * Per-purchase commission override: resolve the affiliate link used for THIS checkout
   * to a Member id. No cookie persistence — only applies to this purchase. Ignores an
   * unknown code or a self-referral (buyer using their own code).
   */
  private async resolveOverrideAffiliator(
    affiliatorCode: string | undefined,
    buyerId: string,
  ): Promise<string | null> {
    if (!affiliatorCode) return null;
    const code = affiliatorCode.slice(0, 8); // first 8 chars = member code (rest = network suffix)
    const affiliator = await prisma.member.findUnique({
      where: { affiliateCode: code },
      select: { id: true },
    });
    if (!affiliator || affiliator.id === buyerId) return null;
    return affiliator.id;
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
    if (!visit) return { affiliatorId: null, programId: null };

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
