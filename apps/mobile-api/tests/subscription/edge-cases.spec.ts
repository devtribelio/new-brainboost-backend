/**
 * BE-21 — gap-filling edge cases on top of the per-task suites:
 * EXPIRED→repurchase creates a NEW sub (not an extension); invite on a full
 * sub → 400; TRUE concurrency: duplicate transactionId race (exactly one
 * activation) and parallel initial race (loser retries onto the renewal
 * branch); 100% voucher-bypass (amount 0) still activates; in-grace subs stay
 * entitled. Real Postgres, no mocks.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@bb/db';
import { commerceEvents } from '@bb/common/events/commerce-events';
import { SubscriptionService } from '@bb/domain/subscription/subscription.service';
import { SeatService } from '@bb/domain/subscription/seat.service';
import { EntitlementService } from '@bb/domain/subscription/entitlement.service';
import { registerSubscriptionActivationListeners } from '@bb/domain/subscription/listeners/subscription-activation.listener';

const subscriptionService = new SubscriptionService();
const seatService = new SeatService();
const entitlement = new EntitlementService();
const uniq = randomUUID().slice(0, 8);
const DAY_MS = 24 * 3600 * 1000;

let ownerId: string;
let soloProductId: string; // 1 seat — full the moment it activates
let duoProductId: string;
let courseId: string;

async function waitFor<T>(fn: () => Promise<T | null | undefined>, ms = 3000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function makePlanProduct(tag: string, seatCount: number): Promise<string> {
  const p = await prisma.product.create({
    data: {
      type: 'subscription',
      code: `TSTEC-${tag}-${uniq}`,
      title: `EC ${tag}`,
      price: 999_000,
      isActive: false,
      status: 'inactive',
    },
  });
  await prisma.subscriptionPlan.create({
    data: {
      productId: p.id,
      code: `TSTEC_${tag}_${uniq}`,
      tier: tag,
      periodMonths: 12,
      seatCount,
      affiliateRate: 40,
      renewalAffiliateRate: 20,
      sortOrder: 99,
    },
  });
  return p.id;
}

async function cleanup() {
  const memberIds = (
    await prisma.member.findMany({ where: { email: { contains: uniq } }, select: { id: true } })
  ).map((m) => m.id);
  const subs = await prisma.memberSubscription.findMany({
    where: { ownerId: { in: memberIds } },
    select: { id: true },
  });
  await prisma.courseEnrollment.deleteMany({
    where: {
      OR: [
        { viaSubscriptionId: { in: subs.map((s) => s.id) } },
        { memberId: { in: memberIds } },
      ],
    },
  });
  await prisma.memberSubscription.deleteMany({ where: { id: { in: subs.map((s) => s.id) } } });
  await prisma.subscriptionPlan.deleteMany({ where: { code: { contains: uniq } } });
  await prisma.product.deleteMany({ where: { code: { contains: uniq } } });
  await prisma.member.deleteMany({ where: { id: { in: memberIds } } });
}

beforeAll(async () => {
  await cleanup();
  registerSubscriptionActivationListeners();
  ownerId = (
    await prisma.member.create({
      data: { email: `ec-owner-${uniq}@test.local`, passwordHash: 'x', isActive: true },
    })
  ).id;
  soloProductId = await makePlanProduct('SOLO', 1);
  duoProductId = await makePlanProduct('DUO', 2);

  const courseProduct = await prisma.product.create({
    data: {
      type: 'course',
      code: `TSTEC-CRS-${uniq}`,
      title: 'EC course',
      price: 100,
      isActive: false,
      status: 'inactive',
    },
  });
  courseId = (await prisma.course.create({ data: { productId: courseProduct.id } })).id;
});

beforeEach(async () => {
  const subs = await prisma.memberSubscription.findMany({
    where: { ownerId },
    select: { id: true },
  });
  await prisma.courseEnrollment.deleteMany({ where: { memberId: ownerId } });
  await prisma.memberSubscription.deleteMany({ where: { id: { in: subs.map((s) => s.id) } } });
});

afterAll(cleanup);

function activate(productId: string, transactionId = randomUUID()) {
  return subscriptionService.activateFromPayment({
    ownerId,
    productId,
    transactionId,
    source: 'xendit',
  });
}

describe('subscription edge cases (BE-21)', () => {
  it('repurchase after EXPIRED creates a NEW sub row — the dead one stays as archive', async () => {
    const first = await activate(duoProductId);
    await prisma.memberSubscription.update({
      where: { id: first.subscription!.id },
      data: {
        status: 'EXPIRED',
        expiresAt: new Date(Date.now() - 30 * DAY_MS),
        graceUntil: new Date(Date.now() - 23 * DAY_MS),
      },
    });

    const again = await activate(duoProductId);
    expect(again.outcome).toBe('initial'); // NOT renewal — fresh sub
    expect(again.subscription!.id).not.toBe(first.subscription!.id);

    const all = await prisma.memberSubscription.findMany({ where: { ownerId } });
    expect(all).toHaveLength(2);
    expect(all.map((s) => s.status).sort()).toEqual(['ACTIVE', 'EXPIRED']);
    // owner's zombie seat on the dead sub was released; they sit on the new one
    const seat = await prisma.subscriptionSeat.findFirst({ where: { memberId: ownerId } });
    expect(seat?.subscriptionId).toBe(again.subscription!.id);
  });

  it('generateInvite on a fully-claimed sub → 400 Semua seat sudah terisi', async () => {
    await activate(soloProductId); // 1 seat, owner claims it on activation
    await expect(seatService.generateInvite(ownerId)).rejects.toThrow('Semua seat sudah terisi');
  });

  it('TRUE duplicate race: two concurrent activations with the SAME transactionId → exactly one wins', async () => {
    const txId = randomUUID();
    const [a, b] = await Promise.all([
      activate(duoProductId, txId),
      activate(duoProductId, txId),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['initial', 'noop']);
    const noop = a.outcome === 'noop' ? a : b;
    expect(noop.noopReason).toBe('duplicate-transaction');

    expect(await prisma.memberSubscription.count({ where: { ownerId } })).toBe(1);
    expect(
      await prisma.subscriptionActivation.count({ where: { transactionId: txId } }),
    ).toBe(1);
    const seats = await prisma.subscriptionSeat.findMany({
      where: { subscription: { ownerId } },
    });
    expect(seats).toHaveLength(2); // pre-provisioned once, not twice
  });

  it('parallel initial race with DIFFERENT transactionIds: loser retries onto the renewal branch', async () => {
    const [a, b] = await Promise.all([
      activate(duoProductId, randomUUID()),
      activate(duoProductId, randomUUID()),
    ]);

    expect([a.outcome, b.outcome].sort()).toEqual(['initial', 'renewal']);
    expect(await prisma.memberSubscription.count({ where: { ownerId } })).toBe(1);

    // Both payments are honored: initial +12mo, renewal +12mo on top.
    const sub = await prisma.memberSubscription.findFirstOrThrow({ where: { ownerId } });
    const expected = new Date();
    expected.setMonth(expected.getMonth() + 24);
    expect(Math.abs(sub.expiresAt.getTime() - expected.getTime())).toBeLessThan(60_000);
    expect(
      await prisma.subscriptionActivation.count({ where: { subscriptionId: sub.id } }),
    ).toBe(2);
  });

  it('100% voucher bypass (amount 0) still activates the sub via the payment event', async () => {
    commerceEvents.emit('commerce.payment.success', {
      paymentId: randomUUID(),
      transactionId: randomUUID(),
      memberId: ownerId,
      productId: duoProductId,
      amount: 0, // fully covered by voucher
      voucherAmount: 999_000,
      voucherId: null,
      affiliateEligible: false,
    });
    const sub = await waitFor(() =>
      prisma.memberSubscription.findFirst({ where: { ownerId, status: 'ACTIVE' } }),
    );
    expect(sub.source).toBe('xendit');
  });

  it('a sub past expiresAt but inside grace is still entitled (media + badge window)', async () => {
    const res = await activate(duoProductId);
    await prisma.memberSubscription.update({
      where: { id: res.subscription!.id },
      data: {
        expiresAt: new Date(Date.now() - 2 * DAY_MS), // lapsed…
        graceUntil: new Date(Date.now() + 5 * DAY_MS), // …but in grace
      },
    });

    expect(await entitlement.hasActiveSubscription(ownerId)).toBe(true);
    await expect(entitlement.assertCourseAccess(ownerId, courseId)).resolves.toBeUndefined();

    // Past grace → gone.
    await prisma.memberSubscription.update({
      where: { id: res.subscription!.id },
      data: { graceUntil: new Date(Date.now() - 1000) },
    });
    expect(await entitlement.hasActiveSubscription(ownerId)).toBe(false);
  });
});
