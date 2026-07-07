/**
 * BE-07 + BE-08 — subscription event bus & commerce activation listener:
 * commerce.payment.success on a plan-backed product creates/renews the sub and
 * emits subscription.activated/renewed AFTER commit; redelivery emits nothing;
 * commerce.payment.refunded revokes (access off now) and emits canceled with
 * reason=refund, idempotently; non-subscription products are untouched; a
 * throwing bus listener never breaks the next one. Real Postgres.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@bb/db';
import { commerceEvents } from '@bb/common/events/commerce-events';
import {
  subscriptionEvents,
  type SubscriptionEventMap,
} from '@bb/common/events/subscription-events';
import { registerSubscriptionActivationListeners } from '@bb/domain/subscription/listeners/subscription-activation.listener';

const uniq = randomUUID().slice(0, 8);

let ownerId: string;
let subProductId: string;
let courseProductId: string;
let subId: () => Promise<string | null>;

type AnyEvent = { name: string; payload: SubscriptionEventMap[keyof SubscriptionEventMap] };
const captured: AnyEvent[] = [];

async function waitFor<T>(fn: () => Promise<T | null | undefined>, ms = 3000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function settle(ms = 250) {
  await new Promise((r) => setTimeout(r, ms));
}

function paymentSuccess(productId: string, transactionId = randomUUID()) {
  commerceEvents.emit('commerce.payment.success', {
    paymentId: randomUUID(),
    transactionId,
    memberId: ownerId,
    productId,
    amount: 999_000,
    voucherAmount: 0,
    affiliateEligible: false,
  });
  return transactionId;
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

beforeAll(async () => {
  await cleanup();
  registerSubscriptionActivationListeners();
  for (const name of [
    'subscription.activated',
    'subscription.renewed',
    'subscription.expired',
    'subscription.canceled',
  ] as const) {
    subscriptionEvents.on(name, (payload) => {
      captured.push({ name, payload });
    });
  }

  const m = await prisma.member.create({
    data: { email: `actl-${uniq}@test.local`, passwordHash: 'x', isActive: true },
  });
  ownerId = m.id;

  const subProduct = await prisma.product.create({
    data: { type: 'subscription', code: `TST-ACTL-SUB-${uniq}`, title: 'Actl sub', price: 999_000 },
  });
  subProductId = subProduct.id;
  await prisma.subscriptionPlan.create({
    data: {
      productId: subProductId,
      code: `TSTL_SOLO_${uniq}`,
      tier: 'SOLO',
      periodMonths: 12,
      seatCount: 1,
      affiliateRate: 40,
      renewalAffiliateRate: 20,
      sortOrder: 99,
    },
  });

  const courseProduct = await prisma.product.create({
    data: { type: 'course', code: `TST-ACTL-CRS-${uniq}`, title: 'Actl course', price: 100 },
  });
  courseProductId = courseProduct.id;
  await prisma.course.create({ data: { productId: courseProduct.id } });

  subId = async () =>
    (await prisma.memberSubscription.findFirst({ where: { ownerId }, select: { id: true } }))?.id ??
    null;
});

beforeEach(async () => {
  captured.length = 0;
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

describe('subscription bus + commerce activation listener (BE-07/BE-08)', () => {
  it('payment success on a plan product creates the sub and emits subscription.activated', async () => {
    const txId = paymentSuccess(subProductId);
    await waitFor(subId);

    const sub = await prisma.memberSubscription.findFirstOrThrow({ where: { ownerId } });
    expect(sub.source).toBe('xendit');

    await waitFor(async () => (captured.length ? captured : null));
    expect(captured).toHaveLength(1);
    expect(captured[0].name).toBe('subscription.activated');
    expect(captured[0].payload).toMatchObject({
      subscriptionId: sub.id,
      ownerId,
      planCode: `TSTL_SOLO_${uniq}`,
      tier: 'SOLO',
      transactionId: txId,
    });
  });

  it('redelivered success (same transactionId) activates once and emits nothing new', async () => {
    const txId = paymentSuccess(subProductId);
    await waitFor(subId);
    await waitFor(async () => (captured.length ? captured : null));

    paymentSuccess(subProductId, txId); // redelivery
    await settle();

    expect(captured).toHaveLength(1); // still only the original activated
    const id = await subId();
    expect(
      await prisma.subscriptionActivation.count({ where: { subscriptionId: id! } }),
    ).toBe(1);
  });

  it('second purchase (new transactionId) renews and emits subscription.renewed', async () => {
    paymentSuccess(subProductId);
    await waitFor(subId);
    paymentSuccess(subProductId);
    await waitFor(async () => (captured.length === 2 ? captured : null));

    expect(captured.map((c) => c.name)).toEqual([
      'subscription.activated',
      'subscription.renewed',
    ]);
    expect(captured[1].payload).toMatchObject({ planChanged: false });
  });

  it('refund revokes the sub (access off now) and emits canceled reason=refund, once', async () => {
    const txId = paymentSuccess(subProductId);
    await waitFor(subId);
    const id = (await subId())!;
    await prisma.courseEnrollment.create({
      data: {
        memberId: ownerId,
        courseId: (await prisma.course.findFirstOrThrow({
          where: { product: { id: courseProductId } },
        })).id,
        viaSubscriptionId: id,
        expiredDate: new Date(Date.now() + 86400_000),
      },
    });

    commerceEvents.emit('commerce.payment.refunded', {
      transactionId: txId,
      memberId: ownerId,
    });
    await waitFor(async () => {
      const s = await prisma.memberSubscription.findUnique({ where: { id } });
      return s?.status === 'CANCELED' ? s : null;
    });

    const lazy = await prisma.courseEnrollment.findFirstOrThrow({
      where: { viaSubscriptionId: id },
    });
    expect(lazy.expiredDate!.getTime()).toBeLessThanOrEqual(Date.now());

    await waitFor(async () => (captured.some((c) => c.name === 'subscription.canceled') ? 1 : null));
    const canceled = captured.filter((c) => c.name === 'subscription.canceled');
    expect(canceled).toHaveLength(1);
    expect(canceled[0].payload).toMatchObject({ reason: 'refund' });

    // Redelivered refund → idempotent, no second event
    commerceEvents.emit('commerce.payment.refunded', { transactionId: txId, memberId: ownerId });
    await settle();
    expect(captured.filter((c) => c.name === 'subscription.canceled')).toHaveLength(1);
  });

  it('non-subscription product payment does not create a sub or emit events', async () => {
    paymentSuccess(courseProductId);
    await settle();
    expect(await subId()).toBeNull();
    expect(captured).toHaveLength(0);
  });

  it('bus isolates a throwing listener from the next one (BE-07)', async () => {
    let secondRan = false;
    subscriptionEvents.on('subscription.expired', () => {
      throw new Error('boom');
    });
    subscriptionEvents.on('subscription.expired', () => {
      secondRan = true;
    });
    subscriptionEvents.emit('subscription.expired', {
      subscriptionId: randomUUID(),
      ownerId,
      planId: randomUUID(),
      planCode: 'X',
      tier: 'X',
      expiresAt: new Date(),
      source: 'xendit',
    });
    await settle(100);
    expect(secondRan).toBe(true);
  });
});
