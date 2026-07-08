/**
 * BE-20 — grant-subscription script: eligibility merges legacy (injected map,
 * incl. member_redirect folding) + new-platform spend; batch guards (active
 * sub / seat / prior-grant LEDGER — an expired granted sub is never
 * re-granted); dry-run writes nothing; re-run grants zero; single grant by
 * email with clear failure on unknown member. Real Postgres; the legacy
 * MariaDB side (fetchLegacyTotals) is exercised operationally, not here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID, randomInt } from 'node:crypto';
import { prisma } from '@bb/db';
import { SubscriptionService } from '@bb/domain/subscription/subscription.service';
import {
  computeEligibility,
  grantEligible,
  grantOne,
} from '../../../../scripts/grant-subscription';

const service = new SubscriptionService();
const uniq = randomUUID().slice(0, 8);
const DAY_MS = 24 * 3600 * 1000;

// Unique legacy ids far above real data range.
const LEG_BASE = 2_000_000_000 - randomInt(1_000_000);
const LEG = {
  rich: LEG_BASE + 1,
  mixed: LEG_BASE + 2,
  poor: LEG_BASE + 3,
  alreadySub: LEG_BASE + 4,
  grantedExpired: LEG_BASE + 5,
  redirectWinner: LEG_BASE + 6,
  redirectLoser: LEG_BASE + 7,
};

let planCode: string;
let planProductId: string;
const memberIds: Record<string, string> = {};

async function makeMember(tag: string, legacyId?: number): Promise<string> {
  const m = await prisma.member.create({
    data: {
      email: `gsc-${tag}-${uniq}@test.local`,
      passwordHash: 'x',
      isActive: true,
      fullName: `GSC ${tag}`,
      ...(legacyId ? { legacyId } : {}),
    },
  });
  memberIds[tag] = m.id;
  return m.id;
}

async function addPaidTx(memberId: string, amount: number) {
  await prisma.commerceTransaction.create({
    data: {
      code: `GSC-${uniq}-${randomUUID().slice(0, 8)}`,
      memberId,
      productId: planProductId, // any product works for spend aggregation
      itemTotal: amount,
      amount,
      status: 'PAID',
      paidAt: new Date(),
    },
  });
}

async function cleanup() {
  const ids = (
    await prisma.member.findMany({ where: { email: { contains: uniq } }, select: { id: true } })
  ).map((m) => m.id);
  await prisma.notification.deleteMany({ where: { memberId: { in: ids } } });
  await prisma.commerceTransaction.deleteMany({ where: { memberId: { in: ids } } });
  const subs = await prisma.memberSubscription.findMany({
    where: { ownerId: { in: ids } },
    select: { id: true },
  });
  await prisma.notificationOutbox.deleteMany({
    where: { refId: { in: subs.map((s) => s.id) } },
  });
  await prisma.memberSubscription.deleteMany({ where: { id: { in: subs.map((s) => s.id) } } });
  await prisma.memberRedirect.deleteMany({ where: { loserLegacyId: LEG.redirectLoser } });
  await prisma.subscriptionPlan.deleteMany({ where: { code: { contains: uniq } } });
  await prisma.product.deleteMany({ where: { code: { contains: uniq } } });
  await prisma.member.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  await cleanup();

  const product = await prisma.product.create({
    data: {
      type: 'subscription',
      code: `TSTGS-${uniq}`,
      title: 'Grant script sub',
      price: 999_000,
      isActive: false,
      status: 'inactive',
    },
  });
  planProductId = product.id;
  planCode = `TSTGS_SOLO_${uniq}`;
  await prisma.subscriptionPlan.create({
    data: {
      productId: planProductId,
      code: planCode,
      tier: 'SOLO',
      periodMonths: 12,
      seatCount: 1,
      affiliateRate: 40,
      renewalAffiliateRate: 20,
      sortOrder: 99,
    },
  });

  // rich: pure legacy spend 2.5jt
  await makeMember('rich', LEG.rich);
  // mixed: 1.5jt legacy + 0.6jt new = 2.1jt (cross-source sum)
  const mixed = await makeMember('mixed', LEG.mixed);
  await addPaidTx(mixed, 600_000);
  // poor: 1jt legacy only
  await makeMember('poor', LEG.poor);
  // newRich: pure new-platform 2.1jt
  const newRich = await makeMember('newRich');
  await addPaidTx(newRich, 2_100_000);
  // alreadySub: eligible but has an ACTIVE sub
  const alreadySub = await makeMember('alreadySub', LEG.alreadySub);
  await service.grant(alreadySub, planCode);
  // grantedExpired: eligible, granted before, sub now EXPIRED — ledger must block
  const grantedExpired = await makeMember('grantedExpired', LEG.grantedExpired);
  const g = await service.grant(grantedExpired, planCode);
  await prisma.memberSubscription.update({
    where: { id: g.subscription.id },
    data: {
      status: 'EXPIRED',
      expiresAt: new Date(Date.now() - 30 * DAY_MS),
      graceUntil: new Date(Date.now() - 23 * DAY_MS),
    },
  });
  // redirect: loser's legacy spend folds into winner
  await makeMember('redirectWinner', LEG.redirectWinner);
  await prisma.memberRedirect.create({
    data: { loserLegacyId: LEG.redirectLoser, winnerLegacyId: LEG.redirectWinner },
  });
});

afterAll(cleanup);

/** The injected stand-in for fetchLegacyTotals (MariaDB), keyed by legacy id. */
function legacyTotals(): Map<number, number> {
  return new Map([
    [LEG.rich, 2_500_000],
    [LEG.mixed, 1_500_000],
    [LEG.poor, 1_000_000],
    [LEG.alreadySub, 3_000_000],
    [LEG.grantedExpired, 3_000_000],
    [LEG.redirectWinner, 1_200_000],
    [LEG.redirectLoser, 900_000], // folds onto winner → 2.1jt
  ]);
}

function ours(rows: Awaited<ReturnType<typeof computeEligibility>>['rows']) {
  return rows.filter((r) => r.email?.includes(uniq));
}

describe('grant-subscription script (BE-20)', () => {
  it('merges legacy + new spend, folds redirects, and applies the three skip guards', async () => {
    const { rows } = await computeEligibility(prisma, legacyTotals());
    const mine = ours(rows);
    const byTag = Object.fromEntries(mine.map((r) => [r.email!.split('-')[1], r]));

    expect(byTag.rich).toMatchObject({ action: 'grant', legacyTotal: 2_500_000, newTotal: 0 });
    expect(byTag.mixed).toMatchObject({
      action: 'grant',
      legacyTotal: 1_500_000,
      newTotal: 600_000,
      total: 2_100_000,
    });
    expect(byTag.newRich).toMatchObject({ action: 'grant', legacyTotal: 0, newTotal: 2_100_000 });
    expect(byTag.redirectWinner).toMatchObject({ action: 'grant', legacyTotal: 2_100_000 });
    expect(byTag.poor).toBeUndefined(); // below threshold
    expect(byTag.alreadySub).toMatchObject({ action: 'skip', skipReason: 'already-granted' });
    expect(byTag.grantedExpired).toMatchObject({ action: 'skip', skipReason: 'already-granted' });
  });

  it('dry-run writes nothing', async () => {
    const { rows } = await computeEligibility(prisma, legacyTotals());
    const stats = await grantEligible(prisma, service, ours(rows), {
      planCode,
      dryRun: true,
    });
    expect(stats.granted).toBe(4);
    expect(
      await prisma.memberSubscription.count({
        where: { ownerId: { in: [memberIds.rich, memberIds.mixed, memberIds.newRich] } },
      }),
    ).toBe(0);
  });

  it('real run grants only the grant rows; re-run grants zero (ledger + active-sub guards)', async () => {
    const first = await computeEligibility(prisma, legacyTotals());
    const stats = await grantEligible(prisma, service, ours(first.rows), { planCode });
    expect(stats).toMatchObject({ granted: 4, failed: 0 });

    const richSub = await prisma.memberSubscription.findFirstOrThrow({
      where: { ownerId: memberIds.rich },
    });
    expect(richSub.source).toBe('granted');
    expect(richSub.status).toBe('ACTIVE');
    const ledger = await prisma.subscriptionActivation.findMany({
      where: { subscriptionId: richSub.id },
    });
    expect(ledger).toEqual([expect.objectContaining({ kind: 'grant', transactionId: null })]);

    // Re-run: every previous grantee is now skipped.
    const second = await computeEligibility(prisma, legacyTotals());
    const mine = ours(second.rows);
    expect(mine.every((r) => r.action === 'skip')).toBe(true);
    const rerun = await grantEligible(prisma, service, mine, { planCode });
    expect(rerun.granted).toBe(0);
    expect(
      await prisma.memberSubscription.count({ where: { ownerId: memberIds.rich } }),
    ).toBe(1); // still exactly one — no extension either
  });

  it('grantOne: dry-run writes nothing; real grant works by email; unknown member fails clearly', async () => {
    const poorEmail = `gsc-poor-${uniq}@test.local`;
    const dry = await grantOne(prisma, service, { email: poorEmail, planCode, dryRun: true });
    expect(dry.outcome).toBe('dry-run');
    expect(
      await prisma.memberSubscription.count({ where: { ownerId: memberIds.poor } }),
    ).toBe(0);

    const real = await grantOne(prisma, service, { email: poorEmail, planCode, months: 3 });
    expect(real.outcome).toBe('created');
    const sub = await prisma.memberSubscription.findFirstOrThrow({
      where: { ownerId: memberIds.poor },
    });
    const expected = new Date();
    expected.setMonth(expected.getMonth() + 3);
    expect(Math.abs(sub.expiresAt.getTime() - expected.getTime())).toBeLessThan(60_000);

    await expect(
      grantOne(prisma, service, { email: `nope-${uniq}@test.local`, planCode }),
    ).rejects.toThrow('Member not found');
  });
});
