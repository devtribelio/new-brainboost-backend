/**
 * BE-03 — SubscriptionService.activateFromPayment state machine:
 * initial activation (seats pre-provisioned, owner on seat 1), renewal math
 * (future expiry extends from expiry; lapsed-in-grace extends from now),
 * ledger idempotency (redelivered transactionId = strict no-op), provider
 * expiry override, cancel-intent cleared on repurchase, lazy-enrollment bump,
 * plan change seat reconciliation. Real Postgres, no mocks.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@bb/db';
import { SubscriptionService } from '@bb/domain/subscription/subscription.service';

const service = new SubscriptionService();

const DAY_MS = 24 * 60 * 60 * 1000;
const uniq = randomUUID().slice(0, 8);

let ownerId: string;
let soloProductId: string;
let duoProductId: string;
let courseId: string;

async function makeMember(tag: string): Promise<string> {
  const m = await prisma.member.create({
    data: {
      email: `sub-act-${tag}-${uniq}@test.local`,
      passwordHash: 'x',
      isActive: true,
    },
  });
  return m.id;
}

/** Seed a plan pair (SOLO-ish 2 seats, DUO-ish 3 seats) scoped to this spec run. */
async function makePlan(tag: string, seatCount: number): Promise<{ productId: string }> {
  const product = await prisma.product.create({
    data: {
      type: 'subscription',
      code: `TST-SUB-${tag}-${uniq}`,
      title: `Test sub ${tag}`,
      price: 999_000,
    },
  });
  await prisma.subscriptionPlan.create({
    data: {
      productId: product.id,
      code: `TST_${tag}_${uniq}`,
      tier: tag,
      periodMonths: 12,
      seatCount,
      affiliateRate: 40,
      renewalAffiliateRate: 20,
      sortOrder: 99,
    },
  });
  return { productId: product.id };
}

async function cleanup() {
  const subs = await prisma.memberSubscription.findMany({
    where: { plan: { code: { contains: uniq } } },
    select: { id: true },
  });
  const subIds = subs.map((s) => s.id);
  await prisma.courseEnrollment.deleteMany({ where: { viaSubscriptionId: { in: subIds } } });
  await prisma.memberSubscription.deleteMany({ where: { id: { in: subIds } } });
  await prisma.subscriptionPlan.deleteMany({ where: { code: { contains: uniq } } });
  await prisma.product.deleteMany({ where: { code: { contains: uniq } } });
  await prisma.courseEnrollment.deleteMany({ where: { member: { email: { contains: uniq } } } });
  await prisma.member.deleteMany({ where: { email: { contains: uniq } } });
}

beforeAll(async () => {
  await cleanup();
  ownerId = await makeMember('owner');
  ({ productId: soloProductId } = await makePlan('SOLO', 2));
  ({ productId: duoProductId } = await makePlan('DUO', 3));

  const courseProduct = await prisma.product.create({
    data: { type: 'course', code: `TST-CRS-${uniq}`, title: 'Test course', price: 100 },
  });
  const course = await prisma.course.create({ data: { productId: courseProduct.id } });
  courseId = course.id;
});

beforeEach(async () => {
  // Each test starts with no subscription for the owner.
  const subs = await prisma.memberSubscription.findMany({
    where: { ownerId },
    select: { id: true },
  });
  await prisma.courseEnrollment.deleteMany({
    where: { viaSubscriptionId: { in: subs.map((s) => s.id) } },
  });
  await prisma.memberSubscription.deleteMany({ where: { ownerId } });
});

afterAll(cleanup);

function activate(overrides: Partial<Parameters<SubscriptionService['activateFromPayment']>[0]> = {}) {
  return service.activateFromPayment({
    ownerId,
    productId: soloProductId,
    transactionId: randomUUID(),
    source: 'xendit',
    ...overrides,
  });
}

describe('SubscriptionService.activateFromPayment', () => {
  it('no-ops for a product without a plan', async () => {
    const courseProduct = await prisma.course.findUniqueOrThrow({
      where: { id: courseId },
      select: { productId: true },
    });
    const res = await activate({ productId: courseProduct.productId });
    expect(res.outcome).toBe('noop');
    expect(res.noopReason).toBe('no-plan');
  });

  it('initial activation creates the sub, pre-provisions seats, owner on seat 1', async () => {
    const res = await activate();
    expect(res.outcome).toBe('initial');
    const sub = res.subscription!;
    expect(sub.status).toBe('ACTIVE');

    // expiry ≈ now + 12 months, graceUntil = expiry + 7d (seeded setting)
    const expectedExpiry = new Date();
    expectedExpiry.setMonth(expectedExpiry.getMonth() + 12);
    expect(Math.abs(sub.expiresAt.getTime() - expectedExpiry.getTime())).toBeLessThan(60_000);
    expect(sub.graceUntil!.getTime() - sub.expiresAt.getTime()).toBe(7 * DAY_MS);

    const seats = await prisma.subscriptionSeat.findMany({
      where: { subscriptionId: sub.id },
      orderBy: { seatNo: 'asc' },
    });
    expect(seats).toHaveLength(2);
    expect(seats[0]).toMatchObject({ seatNo: 1, memberId: ownerId });
    expect(seats[0].claimedAt).not.toBeNull();
    expect(seats[1]).toMatchObject({ seatNo: 2, memberId: null });
  });

  it('redelivered transactionId is a strict no-op (ledger idempotency)', async () => {
    const txId = randomUUID();
    const first = await activate({ transactionId: txId });
    const before = first.subscription!;

    const replay = await activate({ transactionId: txId });
    expect(replay.outcome).toBe('noop');
    expect(replay.noopReason).toBe('duplicate-transaction');

    const after = await prisma.memberSubscription.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());
    expect(
      await prisma.subscriptionSeat.count({ where: { subscriptionId: before.id } }),
    ).toBe(2);
    expect(
      await prisma.subscriptionActivation.count({ where: { subscriptionId: before.id } }),
    ).toBe(1);
  });

  it('renewal extends from current expiry when not yet lapsed and clears cancel-intent', async () => {
    const first = await activate();
    const sub = first.subscription!;
    await prisma.memberSubscription.update({
      where: { id: sub.id },
      data: { canceledAt: new Date() }, // pending cancel-intent
    });

    const res = await activate();
    expect(res.outcome).toBe('renewal');
    const renewed = res.subscription!;

    const expected = new Date(sub.expiresAt);
    expected.setMonth(expected.getMonth() + 12);
    expect(renewed.expiresAt.getTime()).toBe(expected.getTime());
    expect(renewed.canceledAt).toBeNull();

    const ledger = await prisma.subscriptionActivation.findMany({
      where: { subscriptionId: sub.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(ledger.map((l) => l.kind)).toEqual(['initial', 'renewal']);
    expect(ledger[1].previousExpiresAt?.getTime()).toBe(sub.expiresAt.getTime());
  });

  it('renewal of a lapsed-in-grace sub anchors to the OLD expiry — grace is breathing room, not bonus time', async () => {
    // BB-79 amendment (2026-07-10): expired 9 Jul, paid 10 Jul (in grace) →
    // next expiry 9 Jul next year, NOT 10 Jul.
    const first = await activate();
    const sub = first.subscription!;
    const pastExpiry = new Date(Date.now() - 3 * DAY_MS); // expired 3 days ago, still ACTIVE (grace)
    await prisma.memberSubscription.update({
      where: { id: sub.id },
      data: { expiresAt: pastExpiry },
    });

    const res = await activate();
    const expected = new Date(pastExpiry);
    expected.setMonth(expected.getMonth() + 12);
    expect(res.subscription!.expiresAt.getTime()).toBe(expected.getTime());
  });

  it('provider expiry (RC) wins over local math', async () => {
    const providerExpiresAt = new Date(Date.now() + 400 * DAY_MS);
    const res = await activate({
      source: 'revenuecat',
      providerRef: 'rc-orig-tx-1',
      providerExpiresAt,
    });
    expect(res.subscription!.expiresAt.getTime()).toBe(providerExpiresAt.getTime());
    expect(res.subscription!.providerRef).toBe('rc-orig-tx-1');
  });

  it('renewal bumps expired_date of lazy enrollments, never retail rows', async () => {
    const first = await activate();
    const sub = first.subscription!;

    const retailExpiry = new Date('2030-01-01');
    await prisma.courseEnrollment.create({
      data: {
        memberId: ownerId,
        courseId,
        viaSubscriptionId: sub.id,
        expiredDate: sub.expiresAt,
      },
    });
    const retailMember = await makeMember('retail');
    await prisma.courseEnrollment.create({
      data: { memberId: retailMember, courseId, expiredDate: retailExpiry },
    });

    const res = await activate();
    const lazy = await prisma.courseEnrollment.findUniqueOrThrow({
      where: { memberId_courseId: { memberId: ownerId, courseId } },
    });
    expect(lazy.expiredDate!.getTime()).toBe(res.subscription!.expiresAt.getTime());

    const retail = await prisma.courseEnrollment.findUniqueOrThrow({
      where: { memberId_courseId: { memberId: retailMember, courseId } },
    });
    expect(retail.expiredDate!.getTime()).toBe(retailExpiry.getTime()); // untouched
  });

  it('plan change (RC PRODUCT_CHANGE) grows seats without touching claimed ones', async () => {
    const first = await activate(); // SOLO-ish: 2 seats
    const res = await activate({ productId: duoProductId }); // → 3 seats
    expect(res.outcome).toBe('plan_change');

    const seats = await prisma.subscriptionSeat.findMany({
      where: { subscriptionId: first.subscription!.id },
      orderBy: { seatNo: 'asc' },
    });
    expect(seats).toHaveLength(3);
    expect(seats[0].memberId).toBe(ownerId); // owner seat survived
    expect(seats.slice(1).every((s) => s.memberId === null)).toBe(true);
  });

  it('plan change shrink drops only EMPTY seats', async () => {
    const member2 = await makeMember('seat2');
    const first = await activate({ productId: duoProductId }); // 3 seats
    const subId = first.subscription!.id;
    await prisma.subscriptionSeat.update({
      where: { subscriptionId_seatNo: { subscriptionId: subId, seatNo: 2 } },
      data: { memberId: member2, claimedAt: new Date() },
    });

    const res = await activate({ productId: soloProductId }); // → 2 seats
    expect(res.outcome).toBe('plan_change');
    const seats = await prisma.subscriptionSeat.findMany({
      where: { subscriptionId: subId },
      orderBy: { seatNo: 'asc' },
    });
    expect(seats).toHaveLength(2);
    expect(seats.map((s) => s.memberId)).toEqual([ownerId, member2]); // empty seat 3 dropped
  });

  it('owner already seated on another sub → new sub created with seat 1 empty', async () => {
    // owner2 claims a seat on owner1's sub, then buys their own sub.
    const owner2 = await makeMember('owner2');
    const first = await activate(); // ownerId's sub, 2 seats
    await prisma.subscriptionSeat.update({
      where: {
        subscriptionId_seatNo: { subscriptionId: first.subscription!.id, seatNo: 2 },
      },
      data: { memberId: owner2, claimedAt: new Date() },
    });

    const res = await service.activateFromPayment({
      ownerId: owner2,
      productId: soloProductId,
      transactionId: randomUUID(),
      source: 'revenuecat',
    });
    expect(res.outcome).toBe('initial');
    const seats = await prisma.subscriptionSeat.findMany({
      where: { subscriptionId: res.subscription!.id },
    });
    expect(seats).toHaveLength(2);
    expect(seats.every((s) => s.memberId === null)).toBe(true); // seat 1 left empty
  });
});
