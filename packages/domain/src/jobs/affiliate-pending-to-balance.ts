import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import {
  COMMISSION_STATUS,
  PENDING_TO_BALANCE_DAYS,
  AFFILIATE_IAP_HOLD_DAYS,
  IAP_CHANNELS,
} from '@bb/domain/affiliate/constants';
import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';

/**
 * Background job: promote affiliate commissions PENDING -> BALANCE once they have
 * cleared the hold window. A BALANCE commission is what `getWithdrawableBalance`
 * counts toward a payout.
 *
 * Hold windows are per payment channel because settlement timelines differ:
 *  - IAP channels (Apple/Google via RevenueCat): monthly settlement → 35-day default hold
 *    (runtime-configurable via app_settings key `affiliate.iapHoldDays`).
 *  - All other channels (xendit, scalev, lynkid, null/legacy/web): 7-day default hold
 *    (runtime-configurable via app_settings key `affiliate.holdDays`).
 *
 * The function runs two updateMany queries per invocation:
 *  1. IAP batch  — channel IN IAP_CHANNELS, createdAt ≤ iapCutoff.
 *  2. Default batch — channel NOT IN IAP_CHANNELS OR channel IS NULL, createdAt ≤ defaultCutoff.
 *     (Prisma `notIn` excludes nulls implicitly, so NULL rows are handled via an explicit OR.)
 *
 * Legacy parity note: the old system posted to the wallet immediately when the
 * recipient's member_network was not expired (expired_date defaulted +30yr, so
 * effectively always), and held the rest as `is_pending`. The new model uses an
 * explicit N-day hold for refund/chargeback safety. VOIDED rows are never touched.
 *
 * Designed to be called from an external scheduler.
 *
 * @param now           Reference timestamp (defaults to now). Useful for deterministic tests.
 * @param holdDays      Override the default (non-IAP) hold window in days.
 * @param iapHoldDays   Override the IAP hold window in days.
 */
export async function affiliatePendingToBalance(
  now: Date = new Date(),
  holdDays?: number,
  iapHoldDays?: number,
): Promise<{ promoted: number }> {
  const days =
    holdDays ??
    (await settingsService.getNumber(SETTING_KEYS.affiliateHoldDays, PENDING_TO_BALANCE_DAYS));
  const iapDays =
    iapHoldDays ??
    (await settingsService.getNumber(SETTING_KEYS.affiliateIapHoldDays, AFFILIATE_IAP_HOLD_DAYS));

  const defaultCutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const iapCutoff = new Date(now.getTime() - iapDays * 24 * 60 * 60 * 1000);

  // IAP batch: only commissions tagged with an IAP channel.
  const iapResult = await prisma.affiliateCommission.updateMany({
    where: {
      status: COMMISSION_STATUS.PENDING,
      channel: { in: IAP_CHANNELS as unknown as string[] },
      createdAt: { lte: iapCutoff },
    },
    data: {
      status: COMMISSION_STATUS.BALANCE,
      approvedAt: now,
    },
  });

  // Default batch: xendit, scalev, lynkid, and null (legacy/web pre-tagging rows).
  // Prisma's `notIn` excludes NULL rows, so they must be included via an explicit OR.
  const defaultResult = await prisma.affiliateCommission.updateMany({
    where: {
      status: COMMISSION_STATUS.PENDING,
      createdAt: { lte: defaultCutoff },
      OR: [{ channel: { notIn: IAP_CHANNELS as unknown as string[] } }, { channel: null }],
    },
    data: {
      status: COMMISSION_STATUS.BALANCE,
      approvedAt: now,
    },
  });

  const promoted = iapResult.count + defaultResult.count;

  if (promoted > 0) {
    logger.info(
      {
        promoted,
        iapPromoted: iapResult.count,
        defaultPromoted: defaultResult.count,
        defaultCutoff,
        iapCutoff,
      },
      '[affiliate-pending-cron] promoted PENDING -> BALANCE (per-channel hold)',
    );
  }

  return { promoted };
}
