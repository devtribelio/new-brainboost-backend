/**
 * BE-18 — subscription email receipts (producer side): activated/renewed
 * events enqueue SubscriptionActivated/SubscriptionRenewed outbox rows with
 * refId = subscriptionId; a plan-product payment no longer enqueues the
 * wrong-context CoursePaymentSuccess (retail still does). Rendering lives in
 * bb-comms (external dependency). Real Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@bb/db';
import { commerceEvents } from '@bb/common/events/commerce-events';
import { subscriptionEvents } from '@bb/common/events/subscription-events';
import { registerSubscriptionEmailListeners } from '@bb/domain/comms/listeners/subscription-email.listener';
import { registerCommsEmailListeners } from '@bb/domain/comms/listeners/commerce-email.listener';

const uniq = randomUUID().slice(0, 8);

let planProductId: string;
let retailProductId: string;
let memberId: string;

async function settle(ms = 250) {
  await new Promise((r) => setTimeout(r, ms));
}

async function cleanup() {
  await prisma.notificationOutbox.deleteMany({
    where: {
      OR: [
        { refId: { contains: uniq } },
        {
          type: { in: ['SubscriptionActivated', 'SubscriptionRenewed', 'CoursePaymentSuccess'] },
          refId: { in: [`tx-plan-${uniq}`, `tx-retail-${uniq}`, `sub-${uniq}`, `sub-renew-${uniq}`] },
        },
      ],
    },
  });
  await prisma.subscriptionPlan.deleteMany({ where: { code: { contains: uniq } } });
  await prisma.product.deleteMany({ where: { code: { contains: uniq } } });
  await prisma.member.deleteMany({ where: { email: { contains: uniq } } });
}

beforeAll(async () => {
  await cleanup();
  registerSubscriptionEmailListeners();
  registerCommsEmailListeners();

  memberId = (
    await prisma.member.create({
      data: { email: `semail-${uniq}@test.local`, passwordHash: 'x', isActive: true },
    })
  ).id;

  const planProduct = await prisma.product.create({
    data: {
      type: 'subscription',
      code: `TSTSE-SUB-${uniq}`,
      title: 'SE sub',
      price: 999_000,
      isActive: false,
      status: 'inactive',
    },
  });
  planProductId = planProduct.id;
  await prisma.subscriptionPlan.create({
    data: {
      productId: planProductId,
      code: `TSTSE_SOLO_${uniq}`,
      tier: 'SOLO',
      periodMonths: 12,
      seatCount: 1,
      affiliateRate: 40,
      renewalAffiliateRate: 20,
      sortOrder: 99,
    },
  });
  retailProductId = (
    await prisma.product.create({
      data: {
        type: 'course',
        code: `TSTSE-CRS-${uniq}`,
        title: 'SE course',
        price: 100,
        isActive: false,
        status: 'inactive',
      },
    })
  ).id;
});

afterAll(cleanup);

function lifecyclePayload(subscriptionId: string) {
  return {
    subscriptionId,
    ownerId: memberId,
    planId: randomUUID(),
    planCode: `TSTSE_SOLO_${uniq}`,
    tier: 'SOLO',
    expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000),
    source: 'xendit',
    transactionId: randomUUID(),
  };
}

function outbox(type: string, refId: string) {
  return prisma.notificationOutbox.findMany({ where: { type, refId } });
}

describe('subscription email receipts (BE-18)', () => {
  it('subscription.activated enqueues SubscriptionActivated with refId = subscriptionId', async () => {
    const subId = `sub-${uniq}`;
    subscriptionEvents.emit('subscription.activated', lifecyclePayload(subId));
    await settle();
    const rows = await outbox('SubscriptionActivated', subId);
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe('email');
  });

  it('subscription.renewed enqueues SubscriptionRenewed', async () => {
    const subId = `sub-renew-${uniq}`;
    subscriptionEvents.emit('subscription.renewed', {
      ...lifecyclePayload(subId),
      planChanged: false,
    });
    await settle();
    expect(await outbox('SubscriptionRenewed', subId)).toHaveLength(1);
  });

  it('a tier change sends ONE receipt, carrying what the DB can no longer answer', async () => {
    const subId = `sub-change-${uniq}`;
    // Both events fire for a tier change, in this order.
    subscriptionEvents.emit('subscription.renewed', {
      ...lifecyclePayload(subId),
      planChanged: true,
    });
    subscriptionEvents.emit('subscription.plan_changed', {
      ...lifecyclePayload(subId),
      previousPlanCode: 'FAMILY_12M',
      previousTier: 'FAMILY',
      // Real ids: the seat-ended listener looks these up, and members.id is
      // @db.Uuid — a placeholder string makes Prisma throw on the query.
      evictedMemberIds: [memberId],
    });
    await settle();

    const rows = await outbox('SubscriptionRenewed', subId);
    expect(rows).toHaveLength(1); // renewed stood down for plan_changed
    // bb-comms reads by refId, and by then plan_id already points at the NEW
    // plan — so the previous tier can only reach it through the payload.
    expect(rows[0].payload).toMatchObject({
      previousTier: 'FAMILY',
      previousPlanCode: 'FAMILY_12M',
      evictedCount: 1,
    });
  });

  it('a seat member gets one email per way of losing the seat, addressed to them', async () => {
    const subId = `sub-seat-${uniq}`;
    const seatMember = await prisma.member.create({
      data: {
        email: `seat-ended-${uniq}@test.local`,
        fullName: 'Seat Member',
        passwordHash: 'x',
        isActive: true,
      },
    });

    subscriptionEvents.emit('subscription.seat_removed', {
      ...lifecyclePayload(subId),
      memberId: seatMember.id,
    });
    subscriptionEvents.emit('subscription.plan_changed', {
      ...lifecyclePayload(subId),
      previousPlanCode: 'FAMILY_12M',
      previousTier: 'FAMILY',
      evictedMemberIds: [seatMember.id],
    });
    subscriptionEvents.emit('subscription.expired', {
      ...lifecyclePayload(subId),
      seatMemberIds: [seatMember.id],
    });
    await settle();

    const rows = await outbox('SubscriptionSeatEnded', subId);
    expect(rows).toHaveLength(3);
    // Addressed to the seat member — bb-comms resolves refId to the OWNER, so
    // without this the owner would receive all three.
    expect(rows.every((r) => r.recipient === seatMember.email)).toBe(true);
    expect(rows.map((r) => (r.payload as { reason: string }).reason).sort()).toEqual(
      ['expired', 'removed', 'tier_change'],
    );

    await prisma.notificationOutbox.deleteMany({ where: { refId: subId } });
    await prisma.member.delete({ where: { id: seatMember.id } });
  });

  it('plan-product payment does NOT enqueue CoursePaymentSuccess; retail still does', async () => {
    const planTx = `tx-plan-${uniq}`;
    const retailTx = `tx-retail-${uniq}`;
    commerceEvents.emit('commerce.payment.success', {
      paymentId: randomUUID(),
      transactionId: planTx,
      memberId,
      productId: planProductId,
      amount: 999_000,
      voucherAmount: 0,
      affiliateEligible: false,
    });
    commerceEvents.emit('commerce.payment.success', {
      paymentId: randomUUID(),
      transactionId: retailTx,
      memberId,
      productId: retailProductId,
      amount: 100,
      voucherAmount: 0,
      affiliateEligible: false,
    });
    await settle();
    expect(await outbox('CoursePaymentSuccess', planTx)).toHaveLength(0);
    expect(await outbox('CoursePaymentSuccess', retailTx)).toHaveLength(1);
  });
});
