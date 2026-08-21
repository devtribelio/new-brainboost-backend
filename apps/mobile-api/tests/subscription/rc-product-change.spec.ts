/**
 * Scheduled iOS tier change (Approach B step 1): a DOWNGRADE PRODUCT_CHANGE is
 * held back instead of applied on receipt — Apple schedules it up to a full term
 * early, so ingesting it stripped the member of the tier they had paid for. The
 * RENEWAL that actually bills the new SKU is what applies it.
 *
 * An UPGRADE is charged immediately by Apple and must still fall through to
 * ingest. Real Postgres, no mocks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@bb/db';
import { RevenueCatWebhookHandler } from '@/modules/webhook/revenuecat.handler';
import { SubscriptionService } from '@bb/domain/subscription/subscription.service';

const handler = new RevenueCatWebhookHandler();
const subscriptionService = new SubscriptionService();
const uniq = randomUUID().slice(0, 8);
const PROVIDER_REF = `otx-${randomUUID().slice(0, 8)}`;

const SKU_SOLO = `com.brainboost.ios.sub_solo_${uniq}`;
const SKU_FAMILY = `com.brainboost.ios.sub_family_${uniq}`;

async function makePlan(tag: string, sku: string, seatCount: number, price: number) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const product = await prisma.product.create({
    data: {
      type: 'subscription',
      code: `TST-PC-${tag}-${uniq}`,
      title: `Test sub ${tag}`,
      price,
      iosProductId: sku,
    },
  });
  await prisma.subscriptionPlan.create({
    data: {
      productId: product.id,
      code: `TST_PC_${tag}_${uniq}`,
      tier: tag,
      periodMonths: 12,
      seatCount,
      affiliateRate: 40,
      renewalAffiliateRate: 20,
      sortOrder: 99,
    },
  });
  return product.id;
}

function productChange(from: string | undefined, to: string | undefined, providerRef?: string) {
  return {
    type: 'PRODUCT_CHANGE',
    id: `pc-${uniq}-${Math.random().toString(36).slice(2, 10)}`,
    product_id: from,
    new_product_id: to,
    transaction_id: `tx-${uniq}`,
    original_transaction_id: providerRef ?? `otx-unknown-${uniq}`,
  };
}

async function cleanup() {
  const subs = await prisma.memberSubscription.findMany({
    where: { plan: { code: { contains: uniq } } },
    select: { id: true },
  });
  await prisma.courseEnrollment.deleteMany({
    where: { viaSubscriptionId: { in: subs.map((s) => s.id) } },
  });
  await prisma.memberSubscription.deleteMany({ where: { id: { in: subs.map((s) => s.id) } } });
  await prisma.subscriptionPlan.deleteMany({ where: { code: { contains: uniq } } });
  await prisma.product.deleteMany({ where: { code: { contains: uniq } } });
  await prisma.member.deleteMany({ where: { email: { contains: uniq } } });
}

let familyProductId: string;
let ownerId: string;

beforeAll(async () => {
  await cleanup();
  await makePlan('SOLO', SKU_SOLO, 1, 999_000);
  familyProductId = await makePlan('FAMILY', SKU_FAMILY, 4, 1_999_000);

  const owner = await prisma.member.create({
    data: { email: `pc-owner-${uniq}@test.local`, passwordHash: 'x', isActive: true },
  });
  ownerId = owner.id;
  const sub = await subscriptionService.activateFromPayment({
    ownerId,
    productId: familyProductId,
    transactionId: randomUUID(),
    source: 'revenuecat',
    providerRef: PROVIDER_REF,
  });
  expect(sub.outcome).toBe('initial');
});

afterAll(cleanup);

describe('RevenueCat PRODUCT_CHANGE', () => {
  it('records a scheduled downgrade instead of applying it', async () => {
    const res = await handler.handle(productChange(SKU_FAMILY, SKU_SOLO, PROVIDER_REF));
    expect(res).toEqual({ handled: true, status: 'product_change_scheduled' });

    const sub = await prisma.memberSubscription.findFirstOrThrow({ where: { ownerId } });
    // Term untouched: still on FAMILY, still 4 seats, same expiry.
    expect(sub.plan?.code ?? (await planCodeOf(sub.planId))).toContain('FAMILY');
    expect(sub.pendingPlanId).not.toBeNull();
    expect(sub.pendingEffectiveAt!.getTime()).toBe(sub.expiresAt.getTime());
    expect(sub.pendingSource).toBe('revenuecat');
    expect(await prisma.subscriptionSeat.count({ where: { subscriptionId: sub.id } })).toBe(4);
  });

  it('redelivery of the same scheduled change is a no-op', async () => {
    const res = await handler.handle(productChange(SKU_FAMILY, SKU_SOLO, PROVIDER_REF));
    expect(res.status).toBe('product_change_unchanged');
  });

  it('a downgrade for an unknown subscription is still not ingested', async () => {
    const res = await handler.handle(productChange(SKU_FAMILY, SKU_SOLO));
    expect(res.status).toBe('product_change_not_found');
  });

  it('lets an upgrade through to ingest', async () => {
    const res = await handler.handle(productChange(SKU_SOLO, SKU_FAMILY));
    expect(res.status).not.toBe('product_change_deferred');
  });

  it('falls through when a SKU maps to no plan', async () => {
    const res = await handler.handle(productChange(SKU_FAMILY, 'com.brainboost.ios.unknown'));
    expect(res.status).not.toBe('product_change_deferred');
  });
});

async function planCodeOf(planId: string): Promise<string> {
  const p = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { id: planId } });
  return p.code;
}
