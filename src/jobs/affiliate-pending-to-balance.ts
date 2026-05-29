import { prisma } from '@bb/db';
import { logger } from '@/config/logger';
import { COMMISSION_STATUS, PENDING_TO_BALANCE_DAYS } from '@/modules/affiliate/constants';
import { settingsService, SETTING_KEYS } from '@/common/services/settings.service';

/**
 * Background job: promote affiliate commissions PENDING -> BALANCE once they have
 * cleared the hold window (PENDING_TO_BALANCE_DAYS). A BALANCE commission is what
 * `getWithdrawableBalance` counts toward a payout.
 *
 * Legacy parity note: the old system posted to the wallet immediately when the
 * recipient's member_network was not expired (expired_date defaulted +30yr, so
 * effectively always), and held the rest as `is_pending`. The new model uses an
 * explicit N-day hold for refund/chargeback safety. VOIDED rows are never touched.
 *
 * Hold window is runtime-configurable via app_settings (affiliate.holdDays); pass `holdDays`
 * explicitly to override (e.g. tests). Designed to be called from an external scheduler.
 */
export async function affiliatePendingToBalance(
  now: Date = new Date(),
  holdDays?: number,
): Promise<{ promoted: number }> {
  const days =
    holdDays ?? (await settingsService.getNumber(SETTING_KEYS.affiliateHoldDays, PENDING_TO_BALANCE_DAYS));
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const res = await prisma.affiliateCommission.updateMany({
    where: {
      status: COMMISSION_STATUS.PENDING,
      createdAt: { lte: cutoff },
    },
    data: {
      status: COMMISSION_STATUS.BALANCE,
      approvedAt: now,
    },
  });

  if (res.count > 0) {
    logger.info({ promoted: res.count, cutoff }, '[affiliate-pending-cron] promoted PENDING -> BALANCE');
  }
  return { promoted: res.count };
}
