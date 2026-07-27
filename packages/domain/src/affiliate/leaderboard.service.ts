import { prisma } from '@bb/db';
import { BadRequestException } from '@bb/common/exceptions';
import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import { AFFILIATE_LEADERBOARD_TOPN_DEFAULT, AFFILIATE_LEADERBOARD_FREEZE_DAYS } from './constants';
import {
  type Period,
  wibPeriodOf,
  isPeriodFrozen,
  isPeriodFuture,
  censorAffiliateName,
} from './leaderboard.util';

export interface LeaderboardEntry {
  rank: number;
  displayName: string;
  totalCommission: number;
}

export interface LeaderboardMe extends LeaderboardEntry {
  inTop: boolean;
}

export interface LeaderboardResult {
  period: { year: number; month: number; frozen: boolean };
  updatedAt: string | null;
  top: LeaderboardEntry[];
  me: LeaderboardMe | null;
}

/**
 * Read side of the monthly affiliate leaderboard (§11 / BB-121). Serves the
 * pre-aggregated `affiliate_leaderboard_monthly` rows: top-N (names censored)
 * plus the caller's own row (uncensored). Never computes on the fly — the job
 * owns aggregation.
 */
export class AffiliateLeaderboardService {
  async getLeaderboard(memberId: string, year?: number, month?: number): Promise<LeaderboardResult> {
    const now = new Date();
    const period: Period =
      year !== undefined && month !== undefined ? { year, month } : wibPeriodOf(now);

    if (period.month < 1 || period.month > 12) {
      throw new BadRequestException('month must be between 1 and 12');
    }
    if (isPeriodFuture(period, now)) {
      throw new BadRequestException('Periode belum tersedia');
    }

    const topN = await settingsService.getNumber(
      SETTING_KEYS.affiliateLeaderboardTopN,
      AFFILIATE_LEADERBOARD_TOPN_DEFAULT,
    );

    const [topRows, meRow] = await Promise.all([
      prisma.affiliateLeaderboardMonthly.findMany({
        where: { periodYear: period.year, periodMonth: period.month },
        orderBy: { rank: 'asc' },
        take: topN,
        include: { member: { select: { fullName: true } } },
      }),
      prisma.affiliateLeaderboardMonthly.findFirst({
        where: { periodYear: period.year, periodMonth: period.month, memberId },
        include: { member: { select: { fullName: true } } },
      }),
    ]);

    const top: LeaderboardEntry[] = topRows.map((r) => ({
      rank: r.rank,
      displayName: censorAffiliateName(r.member.fullName),
      totalCommission: r.totalCommission,
    }));

    const me: LeaderboardMe | null = meRow
      ? {
          rank: meRow.rank,
          displayName: meRow.member.fullName?.trim() || 'Saya',
          totalCommission: meRow.totalCommission,
          inTop: meRow.rank <= topN,
        }
      : null;

    const updatedAt = topRows[0]?.updatedAt ?? meRow?.updatedAt ?? null;

    return {
      period: {
        year: period.year,
        month: period.month,
        frozen: isPeriodFrozen(period, now, AFFILIATE_LEADERBOARD_FREEZE_DAYS),
      },
      updatedAt: updatedAt ? updatedAt.toISOString() : null,
      top,
      me,
    };
  }
}
