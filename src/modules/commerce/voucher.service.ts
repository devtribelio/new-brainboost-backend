import { prisma } from '@bb/db';
import { BadRequestException } from '@/common/exceptions';

export interface VoucherCheckResult {
  valid: boolean;
  voucherId?: string;
  voucherAmount?: number;
  type?: 'PERCENT' | 'AMOUNT';
  reason?: string;
}

export class VoucherService {
  /**
   * Dry-run: lookup voucher + check eligibility for productId. Does NOT redeem.
   * Caller computes discount via `computeTotals()` using returned voucher meta.
   */
  async validate(code: string, productId: string): Promise<VoucherCheckResult> {
    const voucher = await prisma.voucher.findUnique({ where: { code } });
    if (!voucher) return { valid: false, reason: 'Voucher not found' };
    if (!voucher.isActive) return { valid: false, reason: 'Voucher inactive' };
    if (voucher.productId && voucher.productId !== productId) {
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
    };
  }

  /**
   * Atomic redeem — increments `used` if quota still available. Throws if exhausted.
   * Called by `OnCommercePaymentSuccess` listener (P5).
   */
  async redeem(voucherId: string): Promise<void> {
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
      throw new BadRequestException('Voucher exhausted or no longer redeemable');
    }
  }
}
