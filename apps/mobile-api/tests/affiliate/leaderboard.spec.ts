import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { refreshAffiliateLeaderboard } from '@bb/domain/jobs/affiliate-leaderboard';
import { AffiliateLeaderboardService } from '@bb/domain/affiliate/leaderboard.service';
import {
  censorAffiliateName,
  wibMonthStartUtc,
  nextPeriod,
} from '@bb/domain/affiliate/leaderboard.util';

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

// ── Unit: name censoring (pure) ───────────────────────────────────────────────
describe('censorAffiliateName', () => {
  it.each([
    ['Budi Santoso', 'Bud* S.'],
    ['Budi', 'Bud*'],
    ['Al Ghazali', 'Al* G.'],
    ['  rahmat   hidayat ', 'rah* H.'],
    ['', 'Brainboost User'],
  ])('censors %j -> %j', (input, expected) => {
    expect(censorAffiliateName(input)).toBe(expected);
  });

  it('handles null/undefined', () => {
    expect(censorAffiliateName(null)).toBe('Brainboost User');
    expect(censorAffiliateName(undefined)).toBe('Brainboost User');
  });
});

// ── Integration: recompute job ────────────────────────────────────────────────
describe('refreshAffiliateLeaderboard — aggregation + rank (real Postgres)', () => {
  const M = { year: 2999, month: 6 }; // far future → no pre-existing commissions
  const nowInM = new Date(wibMonthStartUtc(M).getTime() + 10 * 86_400_000);

  let mA = '';
  let mB = '';
  let mC = '';

  async function mkMember(): Promise<string> {
    const m = await prisma.member.create({
      data: { email: `lb-${uid()}@test.local`, passwordHash: await bcrypt.hash('s', 4) },
    });
    return m.id;
  }
  function commission(recipientId: string, amount: number, status: string, createdAt: Date) {
    return {
      recipientId,
      amount,
      status,
      commissionRate: 20,
      affiliateBased: 'PERFORMANCE',
      createdAt,
    };
  }

  beforeAll(async () => {
    mA = await mkMember();
    mB = await mkMember();
    mC = await mkMember();

    const inM = nowInM;
    const afterM = wibMonthStartUtc(nextPeriod(M)); // exactly next WIB month start → OUT of range

    await prisma.affiliateCommission.createMany({
      data: [
        commission(mA, 700_000, 'PENDING', inM),
        commission(mA, 300_000, 'BALANCE', inM),
        commission(mA, 200_000, 'MIGRATED', inM), // MIGRATED counts (status != VOIDED)
        commission(mB, 500_000, 'BALANCE', inM),
        commission(mC, 999_000, 'VOIDED', inM), // VOIDED excluded → mC absent
        commission(mB, 999_000, 'BALANCE', afterM), // next month → excluded from M
      ],
    });
  });

  afterAll(async () => {
    await prisma.affiliateLeaderboardMonthly.deleteMany({ where: { periodYear: M.year, periodMonth: M.month } });
    await prisma.affiliateCommission.deleteMany({ where: { recipientId: { in: [mA, mB, mC] } } });
    await prisma.member.deleteMany({ where: { id: { in: [mA, mB, mC] } } });
    await prisma.$disconnect();
  });

  it('ranks by total (excl VOIDED, incl PENDING/MIGRATED); respects WIB month bounds', async () => {
    await refreshAffiliateLeaderboard(nowInM);

    const rows = await prisma.affiliateLeaderboardMonthly.findMany({
      where: { periodYear: M.year, periodMonth: M.month },
      orderBy: { rank: 'asc' },
    });

    expect(rows.map((r) => r.memberId)).toEqual([mA, mB]); // mC (VOIDED-only) absent
    expect(rows[0]).toMatchObject({ memberId: mA, rank: 1, totalCommission: 1_200_000 });
    expect(rows[1]).toMatchObject({ memberId: mB, rank: 2, totalCommission: 500_000 }); // afterM 999k excluded
  });

  it('is idempotent — a second run replaces, not appends', async () => {
    await refreshAffiliateLeaderboard(nowInM);
    const count = await prisma.affiliateLeaderboardMonthly.count({
      where: { periodYear: M.year, periodMonth: M.month },
    });
    expect(count).toBe(2);
  });
});

// ── Integration: read service ─────────────────────────────────────────────────
describe('AffiliateLeaderboardService.getLeaderboard (real Postgres)', () => {
  const svc = new AffiliateLeaderboardService();
  const P = { year: 2001, month: 3 }; // past, unique → isolated
  let top1 = '';
  let top2 = '';
  let meM = '';
  let stranger = '';

  async function mkNamed(fullName: string): Promise<string> {
    const m = await prisma.member.create({
      data: { email: `lbs-${uid()}@test.local`, passwordHash: await bcrypt.hash('s', 4), fullName },
    });
    return m.id;
  }

  beforeAll(async () => {
    top1 = await mkNamed('Budi Santoso');
    top2 = await mkNamed('Siti Aminah');
    meM = await mkNamed('Rahmat Hidayat');
    stranger = await mkNamed('Nobody Here');

    const now = new Date();
    await prisma.affiliateLeaderboardMonthly.createMany({
      data: [
        { periodYear: P.year, periodMonth: P.month, memberId: top1, totalCommission: 1_000_000, rank: 1, updatedAt: now },
        { periodYear: P.year, periodMonth: P.month, memberId: top2, totalCommission: 800_000, rank: 2, updatedAt: now },
        { periodYear: P.year, periodMonth: P.month, memberId: meM, totalCommission: 100_000, rank: 3, updatedAt: now },
      ],
    });
  });

  afterAll(async () => {
    await prisma.affiliateLeaderboardMonthly.deleteMany({ where: { periodYear: P.year, periodMonth: P.month } });
    await prisma.member.deleteMany({ where: { id: { in: [top1, top2, meM, stranger] } } });
    await prisma.$disconnect();
  });

  it('returns censored top + uncensored me + frozen past period', async () => {
    const res = await svc.getLeaderboard(meM, P.year, P.month);

    expect(res.period).toEqual({ year: 2001, month: 3, frozen: true });
    expect(res.updatedAt).not.toBeNull();
    expect(res.top[0]).toMatchObject({ rank: 1, displayName: 'Bud* S.', totalCommission: 1_000_000 });
    // other names never leak uncensored
    expect(res.top.map((t) => t.displayName)).not.toContain('Budi Santoso');
    expect(res.me).toMatchObject({ rank: 3, displayName: 'Rahmat Hidayat', totalCommission: 100_000, inTop: true });
  });

  it('me is null when the caller has no row this period', async () => {
    const res = await svc.getLeaderboard(stranger, P.year, P.month);
    expect(res.me).toBeNull();
    expect(res.top).toHaveLength(3);
  });

  it('rejects a future period', async () => {
    await expect(svc.getLeaderboard(meM, 2999, 1)).rejects.toThrow();
  });
});
