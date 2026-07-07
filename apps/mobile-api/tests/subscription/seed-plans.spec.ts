/**
 * BE-02 — seed-subscription-plans idempotency contract:
 * first run creates 4 products + 4 plans; re-runs create nothing and NEVER
 * overwrite operator-tuned values (price, renewalAffiliateRate); --dry-run
 * writes nothing. Requires a reachable Postgres test DB (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@bb/db';
import {
  seedSubscriptionPlans,
  PLAN_SEEDS,
} from '../../../../scripts/seed-subscription-plans';

const PRODUCT_CODES = PLAN_SEEDS.map((s) => s.productCode);
const PLAN_CODES = PLAN_SEEDS.map((s) => s.planCode);

async function cleanup() {
  await prisma.subscriptionPlan.deleteMany({ where: { code: { in: PLAN_CODES } } });
  await prisma.product.deleteMany({ where: { code: { in: PRODUCT_CODES } } });
}

describe('seedSubscriptionPlans (BE-02)', () => {
  beforeAll(cleanup);
  afterAll(async () => {
    await cleanup();
  });

  it('dry-run reports creations but writes nothing', async () => {
    const stats = await seedSubscriptionPlans(prisma as any, { dryRun: true });
    expect(stats.productsCreated).toBe(4);
    expect(stats.plansCreated).toBe(4);
    expect(await prisma.product.count({ where: { code: { in: PRODUCT_CODES } } })).toBe(0);
    expect(await prisma.subscriptionPlan.count({ where: { code: { in: PLAN_CODES } } })).toBe(0);
  });

  it('first run creates 4 subscription products + 4 plans wired 1:1', async () => {
    const stats = await seedSubscriptionPlans(prisma as any);
    expect(stats).toEqual({
      productsCreated: 4,
      productsSkipped: 0,
      plansCreated: 4,
      plansSkipped: 0,
    });

    const plans = await prisma.subscriptionPlan.findMany({
      where: { code: { in: PLAN_CODES } },
      include: { product: true },
      orderBy: { sortOrder: 'asc' },
    });
    expect(plans).toHaveLength(4);
    expect(plans.map((p) => p.tier)).toEqual(['SOLO', 'DUO', 'FAMILY', 'PREMIUM']);
    expect(plans.map((p) => p.seatCount)).toEqual([1, 2, 4, 6]);
    expect(plans.map((p) => p.product.price)).toEqual([999_000, 1_499_000, 1_999_000, 2_799_000]);
    for (const p of plans) {
      expect(p.product.type).toBe('subscription');
      expect(p.periodMonths).toBe(12);
      expect(p.affiliateRate).toBe(40);
      expect(p.renewalAffiliateRate).toBe(20);
      expect(p.product.iosProductId).toBeTruthy();
      expect(p.product.androidProductId).toBeTruthy();
    }
  });

  it('re-run creates nothing and preserves operator-tuned values', async () => {
    // Simulate runtime ops changes: COO decides the renewal rate, ops reprices.
    await prisma.subscriptionPlan.update({
      where: { code: 'SOLO_12M' },
      data: { renewalAffiliateRate: 25 },
    });
    await prisma.product.update({
      where: { code: 'SUB-SOLO-12M' },
      data: { price: 888_000 },
    });

    const stats = await seedSubscriptionPlans(prisma as any);
    expect(stats).toEqual({
      productsCreated: 0,
      productsSkipped: 4,
      plansCreated: 0,
      plansSkipped: 4,
    });

    const plan = await prisma.subscriptionPlan.findUnique({
      where: { code: 'SOLO_12M' },
      include: { product: true },
    });
    expect(plan?.renewalAffiliateRate).toBe(25);
    expect(plan?.product.price).toBe(888_000);
  });

  it('heals a missing plan without touching the existing product', async () => {
    await prisma.subscriptionPlan.delete({ where: { code: 'SOLO_12M' } });
    const stats = await seedSubscriptionPlans(prisma as any);
    expect(stats.productsCreated).toBe(0);
    expect(stats.plansCreated).toBe(1);
    const plan = await prisma.subscriptionPlan.findUnique({
      where: { code: 'SOLO_12M' },
      include: { product: true },
    });
    // Product kept its operator price; only the plan row was recreated.
    expect(plan?.product.price).toBe(888_000);
    expect(plan?.renewalAffiliateRate).toBe(20);
  });
});
