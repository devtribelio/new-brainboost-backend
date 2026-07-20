import { Prisma } from '@prisma/client';
import { prisma } from '@bb/db';
import { BadRequestException } from '@bb/common/exceptions';

export interface VoucherCheckResult {
  valid: boolean;
  voucherId?: string;
  voucherAmount?: number;
  type?: 'PERCENT' | 'AMOUNT';
  /** Cap for PERCENT vouchers — MUST be threaded into computeTotals or the cap is silently bypassed. */
  maxAmount?: number | null;
  reason?: string;
}

export class VoucherService {
  /**
   * Dry-run: lookup voucher + check eligibility for productId. Does NOT redeem.
   * Caller computes discount via `computeTotals()` using returned voucher meta.
   */
  async validate(code: string, productId: string): Promise<VoucherCheckResult> {
    const voucher = await prisma.voucher.findUnique({
      where: { code },
      include: { products: { select: { productId: true } } },
    });
    if (!voucher) return { valid: false, reason: 'Voucher not found' };
    if (!voucher.isActive) return { valid: false, reason: 'Voucher inactive' };
    // Product whitelist: 0 rows = global; >=1 rows = only the listed products.
    if (voucher.products.length > 0 && !voucher.products.some((p) => p.productId === productId)) {
      return { valid: false, reason: 'Voucher not applicable to this product' };
    }
    const now = new Date();
    if (voucher.startsAt && voucher.startsAt > now) {
      return { valid: false, reason: 'Voucher not yet active' };
    }
    if (voucher.endsAt && voucher.endsAt <= now) {
      return { valid: false, reason: 'Voucher expired' };
    }
    if (voucher.quota != null && voucher.used >= voucher.quota) {
      return { valid: false, reason: 'Voucher quota exhausted' };
    }
    return {
      valid: true,
      voucherId: voucher.id,
      type: voucher.type as 'PERCENT' | 'AMOUNT',
      voucherAmount: voucher.value,
      maxAmount: voucher.maxAmount,
    };
  }

  /**
   * Atomic + idempotent redeem. Claims a per-order slot (`voucher_redemptions`,
   * unique `transactionId`) first, then increments `used` under the quota/window
   * guard. A redelivered `commerce.payment.success` (Xendit webhook retry / event
   * re-emit) re-hits the unique slot → P2002 → silent no-op, so `used` is never
   * double-counted. Distinct orders racing for the last quota slot still resolve to
   * exactly one winner via the increment guard. Called by `OnCommercePaymentSuccess`
   * listener (P5).
   */
  async redeem(voucherId: string, transactionId: string, paymentId?: string | null): Promise<void> {
    // 1. Idempotency claim — first redeem for this order wins; redelivery is a no-op.
    try {
      await prisma.voucherRedemption.create({
        data: { voucherId, transactionId, paymentId: paymentId ?? null },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return; // already redeemed for this order — idempotent
      }
      throw e;
    }

    // 2. Atomic counter increment with quota/window guard.
    const now = new Date();
    const updated = await prisma.$executeRaw`
      UPDATE vouchers
      SET used = used + 1, updated_at = ${now}
      WHERE id = ${voucherId}::uuid
        AND is_active = true
        AND (quota IS NULL OR used < quota)
        AND (starts_at IS NULL OR starts_at <= ${now})
        AND (ends_at IS NULL OR ends_at > ${now})
    `;
    if (updated === 0) {
      // Voucher no longer redeemable — roll back the claim so this order isn't left
      // with a slot it never paid for (invariant: a claim row ⇒ `used` was bumped).
      await prisma.voucherRedemption.delete({ where: { transactionId } }).catch(() => {});
      throw new BadRequestException('Voucher exhausted or no longer redeemable');
    }
  }
}
