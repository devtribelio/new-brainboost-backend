import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { COMMISSION_STATUS, AFFILIATE_LEADERBOARD_FREEZE_DAYS } from '@bb/domain/affiliate/constants';
import {
  type Period,
  wibPeriodOf,
  wibMonthStartUtc,
  nextPeriod,
  prevPeriod,
  isPeriodFrozen,
} from '@bb/domain/affiliate/leaderboard.util';

/**
 * Background job: recompute the pre-aggregated monthly affiliate leaderboard
 * (§11 / BB-121). Each run recomputes the current WIB month, plus the previous
 * month while it is still within the freeze window (commissions mature 7 days
 * after month end). A frozen past month is skipped — it will never change again.
 *
 * Recompute is a FULL replace per period (delete + insert in one tx), because
 * PENDING commissions count and a refund flips one to VOIDED, so a member's
 * total — and therefore rank — can DROP between runs. Incremental would be wrong.
 *
 * Metric: SUM(amount) per recipient where status != VOIDED (PENDING, BALANCE and
 * MIGRATED all count), ranked desc, ties broken by memberId for determinism.
 *
 * @param now Reference timestamp (defaults to now). Injectable for tests.
 */
export async function refreshAffiliateLeaderboard(
  now: Date = new Date(),
): Promise<{ periods: number; rows: number }> {
  const current = wibPeriodOf(now);
  const candidates = [current, prevPeriod(current)];
  const periods = candidates.filter((p) => !isPeriodFrozen(p, now, AFFILIATE_LEADERBOARD_FREEZE_DAYS));

  let rows = 0;
  for (const p of periods) {
    rows += await recomputePeriod(p, now);
  }

  logger.info({ periods: periods.map((p) => `${p.year}-${p.month}`), rows }, '[affiliate-leaderboard] recomputed');
  return { periods: periods.length, rows };
}

async function recomputePeriod(p: Period, now: Date): Promise<number> {
  const start = wibMonthStartUtc(p);
  const end = wibMonthStartUtc(nextPeriod(p));

  const grouped = await prisma.affiliateCommission.groupBy({
    by: ['recipientId'],
    where: {
      status: { not: COMMISSION_STATUS.VOIDED },
      createdAt: { gte: start, lt: end },
    },
    _sum: { amount: true },
  });

  const ranked = grouped
    .map((g) => ({ memberId: g.recipientId, total: g._sum.amount ?? 0 }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total || (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0));

  await prisma.$transaction(async (tx) => {
    await tx.affiliateLeaderboardMonthly.deleteMany({
      where: { periodYear: p.year, periodMonth: p.month },
    });
    if (ranked.length > 0) {
      await tx.affiliateLeaderboardMonthly.createMany({
        data: ranked.map((r, i) => ({
          periodYear: p.year,
          periodMonth: p.month,
          memberId: r.memberId,
          totalCommission: r.total,
          rank: i + 1,
          updatedAt: now, // all rows in a period share the aggregation-run timestamp
        })),
      });
    }
  });

  return ranked.length;
}
