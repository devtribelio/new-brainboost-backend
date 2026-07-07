/**
 * BE-15 + BE-16 + BE-17 — subscription jobs & lifecycle notifications:
 * renewal reminder (insert-first dedupe, smallest-bucket-first suppression,
 * re-arm after renewal, email outbox + push notif), expire job (only
 * past-grace flips, idempotent, emits subscription.expired), notification
 * listener (4 lifecycle labels, dedupe, refund silent, no generic
 * payment-success double for plan products). Real Postgres.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@bb/db';
import { subscriptionRenewalReminder } from '@bb/domain/jobs/subscription-renewal-reminder';
import { subscriptionExpire } from '@bb/domain/jobs/subscription-expire';
import { SubscriptionService } from '@bb/domain/subscription/subscription.service';
import { registerSubscriptionNotificationListener } from '@bb/domain/notification/listeners/subscription.listener';
import { registerCommerceNotificationListener } from '@bb/domain/notification/listeners/commerce.listener';
import { subscriptionEvents } from '@bb/common/events/subscription-events';
import { commerceEvents } from '@bb/common/events/commerce-events';

const subscriptionService = new SubscriptionService();
const uniq = randomUUID().slice(0, 8);
const DAY_MS = 24 * 3600 * 1000;

let ownerId: string;
let productId: string;
let planId: string;

async function cleanup() {
  const memberIds = (
    await prisma.member.findMany({ where: { email: { contains: uniq } }, select: { id: true } })
  ).map((m) => m.id);
  await prisma.notification.deleteMany({ where: { memberId: { in: memberIds } } });
  const subs = await prisma.memberSubscription.findMany({
    where: { ownerId: { in: memberIds } },
    select: { id: true },
  });
  const subIds = subs.map((s) => s.id);
  await prisma.notificationOutbox.deleteMany({ where: { refId: { in: subIds } } });
  await prisma.memberSubscription.deleteMany({ where: { id: { in: subIds } } });
  await prisma.subscriptionPlan.deleteMany({ where: { code: { contains: uniq } } });
  await prisma.product.deleteMany({ where: { code: { contains: uniq } } });
  await prisma.member.deleteMany({ where: { id: { in: memberIds } } });
}

beforeAll(async () => {
  await cleanup();
  registerSubscriptionNotificationListener();
  registerCommerceNotificationListener();

  ownerId = (
    await prisma.member.create({
      data: { email: `sjobs-${uniq}@test.local`, passwordHash: 'x', isActive: true },
    })
  ).id;
  const product = await prisma.product.create({
    data: {
      type: 'subscription',
      code: `TSTJ-SUB-${uniq}`,
      title: 'Jobs sub',
      price: 999_000,
      isActive: false,
      status: 'inactive',
    },
  });
  productId = product.id;
  planId = (
    await prisma.subscriptionPlan.create({
      data: {
        productId,
        code: `TSTJ_SOLO_${uniq}`,
        tier: 'SOLO',
        periodMonths: 12,
        seatCount: 1,
        affiliateRate: 40,
        renewalAffiliateRate: 20,
        sortOrder: 99,
      },
    })
  ).id;
});

beforeEach(async () => {
  await prisma.notification.deleteMany({ where: { memberId: ownerId } });
  const subs = await prisma.memberSubscription.findMany({
    where: { ownerId },
    select: { id: true },
  });
  await prisma.notificationOutbox.deleteMany({
    where: { refId: { in: subs.map((s) => s.id) } },
  });
  await prisma.memberSubscription.deleteMany({ where: { ownerId } });
});

afterAll(cleanup);

async function makeSub(expiresInDays: number) {
  const res = await subscriptionService.activateFromPayment({
    ownerId,
    productId,
    transactionId: randomUUID(),
    source: 'xendit',
  });
  const sub = res.subscription!;
  const expiresAt = new Date(Date.now() + expiresInDays * DAY_MS);
  return prisma.memberSubscription.update({
    where: { id: sub.id },
    data: { expiresAt, graceUntil: new Date(expiresAt.getTime() + 7 * DAY_MS) },
  });
}

function outboxRows(subId: string) {
  return prisma.notificationOutbox.findMany({
    where: { type: 'SubscriptionRenewalReminder', refId: subId },
  });
}

function reminderLogs(subId: string) {
  return prisma.subscriptionReminderLog.findMany({
    where: { subscriptionId: subId },
    orderBy: { daysBefore: 'asc' },
  });
}

async function settle(ms = 250) {
  await new Promise((r) => setTimeout(r, ms));
}

describe('renewal reminder job (BE-15)', () => {
  it('sub at H-6: fires ONLY the H-7 bucket, and a re-run sends nothing new', async () => {
    const sub = await makeSub(6);

    const first = await subscriptionRenewalReminder();
    expect(first.sent).toBe(1);
    expect((await reminderLogs(sub.id)).map((l) => l.daysBefore)).toEqual([7]);
    expect(await outboxRows(sub.id)).toHaveLength(1);

    const second = await subscriptionRenewalReminder();
    expect(second.sent).toBe(0);
    expect(await outboxRows(sub.id)).toHaveLength(1); // exactly one per bucket

    await settle();
    const notifs = await prisma.notification.findMany({
      where: { memberId: ownerId, type: 'subscriptionReminder' },
    });
    expect(notifs).toHaveLength(1);
  });

  it('sub first seen at H-1 gets exactly ONE reminder (smallest bucket), not the ladder', async () => {
    const sub = await makeSub(0.5);
    const res = await subscriptionRenewalReminder();
    expect(res.sent).toBe(1);
    expect((await reminderLogs(sub.id)).map((l) => l.daysBefore)).toEqual([1]);
    expect(await outboxRows(sub.id)).toHaveLength(1);
  });

  it('walks down the ladder as expiry approaches, and a renewal re-arms the next cycle', async () => {
    const sub = await makeSub(6);
    await subscriptionRenewalReminder(); // H-7 fired

    // 3 days later (expiry now 3 days away) — H-3 fires
    await prisma.memberSubscription.update({
      where: { id: sub.id },
      data: { expiresAt: new Date(Date.now() + 2.5 * DAY_MS) },
    });
    // NOTE: moving expiresAt changes the dedupe key — that's exactly the re-arm
    // property, but to test the LADDER we keep the same expiry and time-travel
    // instead: restore original expiry, then pretend "now" is 3.5 days before it.
    await prisma.memberSubscription.update({
      where: { id: sub.id },
      data: { expiresAt: sub.expiresAt },
    });
    const nearExpiry = new Date(sub.expiresAt.getTime() - 2.5 * DAY_MS);
    const ladder = await subscriptionRenewalReminder(nearExpiry);
    expect(ladder.sent).toBe(1);
    expect((await reminderLogs(sub.id)).map((l) => l.daysBefore)).toEqual([3, 7]);

    // Renewal: expiry moves a year out → fresh cycle re-arms automatically.
    await subscriptionService.activateFromPayment({
      ownerId,
      productId,
      transactionId: randomUUID(),
      source: 'xendit',
    });
    const renewed = await prisma.memberSubscription.findUniqueOrThrow({ where: { id: sub.id } });
    const nextCycle = new Date(renewed.expiresAt.getTime() - 2 * DAY_MS);
    const rearmed = await subscriptionRenewalReminder(nextCycle);
    expect(rearmed.sent).toBe(1);
    const logs = await reminderLogs(sub.id);
    expect(logs).toHaveLength(3); // 7 + 3 (old cycle) + 3 (new cycle)
  });

  it('lapsed/expired subs get no reminder', async () => {
    const sub = await makeSub(2);
    await prisma.memberSubscription.update({
      where: { id: sub.id },
      data: { status: 'EXPIRED' },
    });
    const res = await subscriptionRenewalReminder();
    expect(res.sent).toBe(0);
  });
});

describe('expire job (BE-16)', () => {
  it('flips only past-grace subs, exactly once, and emits subscription.expired', async () => {
    const pastGrace = await makeSub(2);
    await prisma.memberSubscription.update({
      where: { id: pastGrace.id },
      data: {
        expiresAt: new Date(Date.now() - 10 * DAY_MS),
        graceUntil: new Date(Date.now() - 3 * DAY_MS),
      },
    });

    const first = await subscriptionExpire();
    expect(first.expired).toBe(1);

    const flipped = await prisma.memberSubscription.findUniqueOrThrow({
      where: { id: pastGrace.id },
    });
    expect(flipped.status).toBe('EXPIRED');

    const second = await subscriptionExpire();
    expect(second.expired).toBe(0); // idempotent

    await settle();
    const notifs = await prisma.notification.findMany({
      where: { memberId: ownerId, type: 'subscriptionExpired' },
    });
    expect(notifs).toHaveLength(1); // event → BE-17 listener, deduped
  });

  it('a sub inside grace is untouched', async () => {
    const inGrace = await makeSub(2);
    await prisma.memberSubscription.update({
      where: { id: inGrace.id },
      data: {
        expiresAt: new Date(Date.now() - 1 * DAY_MS),
        graceUntil: new Date(Date.now() + 6 * DAY_MS),
      },
    });
    const res = await subscriptionExpire();
    expect(res.expired).toBe(0);
    const sub = await prisma.memberSubscription.findUniqueOrThrow({ where: { id: inGrace.id } });
    expect(sub.status).toBe('ACTIVE');
  });
});

describe('lifecycle notifications (BE-17)', () => {
  function emitLifecycle(
    name: 'subscription.activated' | 'subscription.renewed' | 'subscription.canceled',
    extra: Record<string, unknown> = {},
  ) {
    const base = {
      subscriptionId: randomUUID(),
      ownerId,
      planId,
      planCode: `TSTJ_SOLO_${uniq}`,
      tier: 'SOLO',
      expiresAt: new Date(Date.now() + 365 * DAY_MS),
      source: 'xendit',
      transactionId: randomUUID(),
      ...extra,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    subscriptionEvents.emit(name, base as any);
    return base;
  }

  it('activated / renewed / canceled(store) produce one notification each; replays dedupe', async () => {
    const a = emitLifecycle('subscription.activated');
    emitLifecycle('subscription.renewed');
    emitLifecycle('subscription.canceled', { reason: 'store' });
    await settle();

    const types = (
      await prisma.notification.findMany({ where: { memberId: ownerId }, orderBy: { type: 'asc' } })
    ).map((n) => n.type);
    expect(types.sort()).toEqual(
      ['subscriptionActivated', 'subscriptionCanceled', 'subscriptionRenewed'].sort(),
    );

    // replay the activated event — dedupeKey blocks a second row
    emitLifecycle('subscription.activated', {
      subscriptionId: a.subscriptionId,
      transactionId: a.transactionId,
    });
    await settle();
    expect(
      await prisma.notification.count({
        where: { memberId: ownerId, type: 'subscriptionActivated' },
      }),
    ).toBe(1);
  });

  it('canceled(refund) is silent (commerce refund notification covers it)', async () => {
    emitLifecycle('subscription.canceled', { reason: 'refund' });
    await settle();
    expect(
      await prisma.notification.count({
        where: { memberId: ownerId, type: 'subscriptionCanceled' },
      }),
    ).toBe(0);
  });

  it('plan product payment does NOT trigger the generic payment-success notification', async () => {
    commerceEvents.emit('commerce.payment.success', {
      paymentId: randomUUID(),
      transactionId: randomUUID(),
      memberId: ownerId,
      productId, // plan-backed
      amount: 999_000,
      voucherAmount: 0,
      affiliateEligible: false,
    });
    await settle();
    expect(
      await prisma.notification.count({ where: { memberId: ownerId, type: 'paymentSuccess' } }),
    ).toBe(0);
  });
});
