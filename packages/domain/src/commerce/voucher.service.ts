import { Prisma } from '@prisma/client';
import { prisma } from '@bb/db';
import { badRequest, ERROR_CODES, type ErrorCode } from '@bb/common/exceptions';

export type VoucherType = 'PERCENT' | 'AMOUNT' | 'TRIAL';

export interface VoucherCheckResult {
  valid: boolean;
  voucherId?: string;
  voucherAmount?: number;
  type?: VoucherType;
  /** Cap for PERCENT vouchers — MUST be threaded into computeTotals or the cap is silently bypassed. */
  maxAmount?: number | null;
  /** TRIAL only: days of access the grant is worth. */
  trialDays?: number | null;
  reason?: string;
  /**
   * Error code the caller should surface instead of the generic VOUCHER_INVALID.
   * Only set where the member-facing copy has to be specific — "you already used
   * this trial" is actionable, "voucher tidak dapat digunakan" is not.
   */
  errorCode?: ErrorCode;
}

export class VoucherService {
  /**
   * Dry-run: lookup voucher + check eligibility for productId. Does NOT redeem.
   * Caller computes discount via `computeTotals()` using returned voucher meta.
   *
   * `memberId` is required by the TRIAL once-per-member rule, which is enforced
   * HERE rather than by a DB constraint: the proof that a member already used a
   * trial is their enrollment row (`course_enrollment.via_voucher_id`), and a
   * unique index cannot span tables. The residual race — two trial checkouts for
   * the same course landing at once — cannot hand out two grants anyway, because
   * `course_enrollment` is unique on (member_id, course_id); it can only burn an
   * extra `quota` slot.
   */
  async validate(code: string, productId: string, memberId: string): Promise<VoucherCheckResult> {
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
    if (voucher.type === 'TRIAL') {
      // Defence in depth against a bad row: the DB CHECK already rejects
      // trial_days <= 0, but a NULL here would silently grant a 0-day trial.
      if (voucher.trialDays == null || voucher.trialDays <= 0) {
        return { valid: false, reason: 'Trial voucher has no duration' };
      }
      // The once-per-member record is the ENROLLMENT, not a redemption row: it
      // already carries member_id, and — unlike a redemption — it survives expiry,
      // so a member cannot re-trial the same course every time the clock runs out.
      // Deliberately NOT filtered on expiredDate/isCanceled for that reason.
      const prior = await prisma.courseEnrollment.findFirst({
        where: { memberId, viaVoucherId: voucher.id, course: { productId } },
        select: { id: true },
      });
      if (prior) {
        return {
          valid: false,
          reason: 'Trial already used by this member',
          errorCode: ERROR_CODES.VOUCHER_TRIAL_ALREADY_USED,
        };
      }
    }
    return {
      valid: true,
      voucherId: voucher.id,
      type: voucher.type as VoucherType,
      voucherAmount: voucher.value,
      maxAmount: voucher.maxAmount,
      trialDays: voucher.trialDays,
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
      throw badRequest(ERROR_CODES.VOUCHER_EXHAUSTED);
    }
  }
}
