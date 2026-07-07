/**
 * BE-12 + BE-13 — RevenueCat subscription flow, end-to-end over HTTP:
 * Android SKU resolves; INITIAL_PURCHASE binds providerRef + RC expiry;
 * RENEWAL extends to RC expiry and pays the renewal-rate commission exactly
 * once (per-period attributionKey); CANCELLATION branches on cancel_reason
 * (UNSUBSCRIBE → cancel-intent, access continues, commissions intact;
 * CUSTOMER_SUPPORT → full refund path); EXPIRATION expires the sub; retail
 * CANCELLATION without cancel_reason keeps the legacy refund behavior.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '@/app';
import { prisma } from '@bb/db';
import { CredentialService } from '@/modules/ingest/credential.service';
import { subscriptionEvents } from '@bb/common/events/subscription-events';

const app = buildApp();
const uniq = randomUUID().slice(0, 8);
const AUTH = `db-rc-secret-${uniq}`;
const ROUTE = '/api/webhook/revenuecat';
const SKU_ANDROID = `com.brainboost.android.sub_test_${uniq}`;
const SKU_RETAIL = `com.brainboost.ios.retail_test_${uniq}`;
const PRICE = 999_000;
const DAY_MS = 24 * 3600 * 1000;

let inviterId: string;
let buyerId: string;
let refundBuyerId: string;
let planProductId: string;
let retailProductId: string;
let credentialId: string;

const capturedEvents: { name: string; reason?: string }[] = [];

function uid(): string {
  return `rc-${uniq}-${Math.random().toString(36).slice(2, 10)}`;
}

function rcEvent(over: Record<string, unknown> = {}) {
  return {
    api_version: '1.0',
    event: {
      type: 'INITIAL_PURCHASE',
      id: uid(),
      product_id: SKU_ANDROID,
      transaction_id: uid(),
      price: 65.5,
      price_in_purchased_currency: PRICE,
      currency: 'IDR',
      ...over,
    },
  };
}

async function post(body: unknown) {
  return request(app).post(ROUTE).set('authorization', `Bearer ${AUTH}`).send(body);
}

async function waitFor<T>(fn: () => Promise<T | null | undefined>, ms = 3000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function cleanup() {
  const memberIds = (
    await prisma.member.findMany({ where: { email: { contains: uniq } }, select: { id: true } })
  ).map((m) => m.id);
  await prisma.affiliateCommission.deleteMany({
    where: { OR: [{ recipientId: { in: memberIds } }, { buyerMemberId: { in: memberIds } }] },
  });
  await prisma.affiliateAttributionClaim.deleteMany({ where: { provider: 'revenuecat' } });
  await prisma.commercePaymentEvent.deleteMany({
    where: { payment: { memberId: { in: memberIds } } },
  });
  await prisma.commercePayment.deleteMany({ where: { memberId: { in: memberIds } } });
  await prisma.commerceTransaction.deleteMany({ where: { memberId: { in: memberIds } } });
  await prisma.courseEnrollment.deleteMany({ where: { memberId: { in: memberIds } } });
  const subs = await prisma.memberSubscription.findMany({
    where: { ownerId: { in: memberIds } },
    select: { id: true },
  });
  await prisma.memberSubscription.deleteMany({ where: { id: { in: subs.map((s) => s.id) } } });
  await prisma.subscriptionPlan.deleteMany({ where: { code: { contains: uniq } } });
  await prisma.product.deleteMany({ where: { code: { contains: uniq } } });
  await prisma.member.deleteMany({ where: { id: { in: memberIds } } });
}

beforeAll(async () => {
  const inviter = await prisma.member.create({
    data: { email: `rcs-inviter-${uniq}@test.local`, passwordHash: 'x' },
  });
  inviterId = inviter.id;
  const buyer = await prisma.member.create({
    data: { email: `rcs-buyer-${uniq}@test.local`, passwordHash: 'x', inviterId },
  });
  buyerId = buyer.id;
  const refundBuyer = await prisma.member.create({
    data: { email: `rcs-refund-${uniq}@test.local`, passwordHash: 'x', inviterId },
  });
  refundBuyerId = refundBuyer.id;

  const planProduct = await prisma.product.create({
    data: {
      type: 'subscription',
      code: `TSTRC-SUB-${uniq}`,
      title: 'RC sub test',
      price: PRICE,
      isActive: false, // keep out of catalog lists in parallel suites
      status: 'inactive',
      androidProductId: SKU_ANDROID, // Android SKU on purpose — proves the OR resolve
    },
  });
  planProductId = planProduct.id;
  await prisma.subscriptionPlan.create({
    data: {
      productId: planProductId,
      code: `TSTRC_SOLO_${uniq}`,
      tier: 'SOLO',
      periodMonths: 12,
      seatCount: 1,
      affiliateRate: 40,
      renewalAffiliateRate: 20,
      sortOrder: 99,
    },
  });

  const retailProduct = await prisma.product.create({
    data: {
      type: 'course',
      code: `TSTRC-CRS-${uniq}`,
      title: 'RC retail test',
      price: 149_000,
      isActive: false,
      status: 'inactive',
      iosProductId: SKU_RETAIL,
      course: { create: {} },
    },
  });
  retailProductId = retailProduct.id;

  credentialId = (
    await prisma.thirdPartyCredential.create({
      data: {
        name: 'revenuecat',
        keyHash: CredentialService.hash(AUTH),
        isActive: true,
        triggersAffiliate: true, // commission assertions below
        canIngestRefund: true,
      },
    })
  ).id;

  subscriptionEvents.on('subscription.expired', () => {
    capturedEvents.push({ name: 'expired' });
  });
  subscriptionEvents.on('subscription.canceled', (e) => {
    capturedEvents.push({ name: 'canceled', reason: e.reason });
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.thirdPartyCredential.delete({ where: { id: credentialId } });
});

const ORIG_TX = `orig-${uniq}`;
const EXPIRY_1 = new Date(Date.now() + 365 * DAY_MS);
const EXPIRY_2 = new Date(Date.now() + 730 * DAY_MS);
const RENEW_TX = `renew-${uniq}`;

function commissions() {
  return prisma.affiliateCommission.findMany({
    where: { productId: planProductId },
    orderBy: { createdAt: 'asc' },
  });
}

describe('RC subscription flow (BE-12/BE-13)', () => {
  it('INITIAL_PURCHASE via ANDROID SKU: sub bound to providerRef with RC expiry; commission at 40%', async () => {
    const r = await post(
      rcEvent({
        app_user_id: buyerId,
        original_transaction_id: ORIG_TX,
        expiration_at_ms: EXPIRY_1.getTime(),
      }),
    );
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('committed');

    const sub = await waitFor(() =>
      prisma.memberSubscription.findFirst({ where: { ownerId: buyerId } }),
    );
    expect(sub.providerRef).toBe(ORIG_TX);
    expect(sub.source).toBe('revenuecat');
    expect(sub.expiresAt.getTime()).toBe(EXPIRY_1.getTime()); // RC authoritative, not local +12mo

    await waitFor(async () => ((await commissions()).length === 1 ? true : null));
    const [c] = await commissions();
    expect(c).toMatchObject({ recipientId: inviterId, commissionRate: 40, schemaType: 'FLAT' });
  });

  it('RENEWAL extends to the new RC expiry and pays the renewal rate exactly once', async () => {
    const body = rcEvent({
      type: 'RENEWAL',
      app_user_id: buyerId,
      transaction_id: RENEW_TX,
      original_transaction_id: ORIG_TX,
      expiration_at_ms: EXPIRY_2.getTime(),
    });
    const r = await post(body);
    expect(r.body.status).toBe('committed');

    const sub = await waitFor(async () => {
      const s = await prisma.memberSubscription.findFirst({ where: { ownerId: buyerId } });
      return s && s.expiresAt.getTime() === EXPIRY_2.getTime() ? s : null;
    });
    expect(sub.status).toBe('ACTIVE');

    await waitFor(async () => ((await commissions()).length === 2 ? true : null));
    const all = await commissions();
    expect(all.map((c) => c.commissionRate)).toEqual([40, 20]); // renewal rate via per-period claim

    // Redelivered RENEWAL (same transaction_id) → duplicate; nothing changes.
    const replay = await post(body);
    expect(replay.body.status).toBe('duplicate');
    await new Promise((res) => setTimeout(res, 300));
    expect(await commissions()).toHaveLength(2);
  });

  it('CANCELLATION UNSUBSCRIBE → cancel-intent: access continues, commissions intact', async () => {
    const r = await post(
      rcEvent({
        type: 'CANCELLATION',
        cancel_reason: 'UNSUBSCRIBE',
        app_user_id: buyerId,
        transaction_id: RENEW_TX,
        original_transaction_id: ORIG_TX,
      }),
    );
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('cancel_intent');

    const sub = await prisma.memberSubscription.findFirstOrThrow({ where: { ownerId: buyerId } });
    expect(sub.status).toBe('ACTIVE'); // access continues to expiry
    expect(sub.canceledAt).not.toBeNull();
    expect((await commissions()).every((c) => c.status !== 'VOIDED')).toBe(true);
    expect(capturedEvents.filter((e) => e.name === 'canceled')).toEqual([
      { name: 'canceled', reason: 'store' },
    ]);

    // Redelivery → idempotent noop, no duplicate event.
    const replay = await post(
      rcEvent({
        type: 'CANCELLATION',
        cancel_reason: 'UNSUBSCRIBE',
        app_user_id: buyerId,
        original_transaction_id: ORIG_TX,
      }),
    );
    expect(replay.body.status).toBe('cancel_intent_noop');
    expect(capturedEvents.filter((e) => e.name === 'canceled')).toHaveLength(1);
  });

  it('EXPIRATION flips the sub to EXPIRED and emits subscription.expired', async () => {
    const r = await post(
      rcEvent({
        type: 'EXPIRATION',
        app_user_id: buyerId,
        original_transaction_id: ORIG_TX,
      }),
    );
    expect(r.body.status).toBe('expired');

    const sub = await prisma.memberSubscription.findFirstOrThrow({ where: { ownerId: buyerId } });
    expect(sub.status).toBe('EXPIRED');
    expect(capturedEvents.some((e) => e.name === 'expired')).toBe(true);

    const replay = await post(
      rcEvent({ type: 'EXPIRATION', app_user_id: buyerId, original_transaction_id: ORIG_TX }),
    );
    expect(replay.body.status).toBe('expiration_noop');
  });

  it('CANCELLATION CUSTOMER_SUPPORT → full refund: sub CANCELED, commissions VOIDED', async () => {
    const purchaseTx = `refund-tx-${uniq}`;
    const origTx = `refund-orig-${uniq}`;
    await post(
      rcEvent({
        app_user_id: refundBuyerId,
        transaction_id: purchaseTx,
        original_transaction_id: origTx,
        expiration_at_ms: EXPIRY_1.getTime(),
      }),
    );
    await waitFor(() =>
      prisma.memberSubscription.findFirst({ where: { ownerId: refundBuyerId } }),
    );

    const r = await post(
      rcEvent({
        type: 'CANCELLATION',
        cancel_reason: 'CUSTOMER_SUPPORT',
        app_user_id: refundBuyerId,
        transaction_id: purchaseTx,
        original_transaction_id: origTx,
      }),
    );
    expect(r.body.status).toBe('refunded');

    const sub = await waitFor(async () => {
      const s = await prisma.memberSubscription.findFirst({ where: { ownerId: refundBuyerId } });
      return s?.status === 'CANCELED' ? s : null;
    });
    expect(sub.canceledAt).not.toBeNull();

    const voided = await prisma.affiliateCommission.findMany({
      where: { buyerMemberId: refundBuyerId },
    });
    expect(voided.length).toBeGreaterThan(0);
    expect(voided.every((c) => c.status === 'VOIDED')).toBe(true);
    expect(capturedEvents.filter((e) => e.reason === 'refund')).toHaveLength(1);
  });

  it('retail CANCELLATION without cancel_reason keeps the legacy refund path', async () => {
    const purchaseTx = `retail-tx-${uniq}`;
    await post(
      rcEvent({
        app_user_id: buyerId,
        product_id: SKU_RETAIL,
        transaction_id: purchaseTx,
        original_transaction_id: undefined,
        expiration_at_ms: undefined,
      }),
    );
    const course = await prisma.course.findFirstOrThrow({
      where: { productId: retailProductId },
    });
    await waitFor(() =>
      prisma.courseEnrollment.findUnique({
        where: { memberId_courseId: { memberId: buyerId, courseId: course.id } },
      }),
    );

    const r = await post(
      rcEvent({
        type: 'CANCELLATION', // no cancel_reason → legacy refund
        app_user_id: buyerId,
        product_id: SKU_RETAIL,
        transaction_id: purchaseTx,
      }),
    );
    expect(r.body.status).toBe('refunded');
    expect(
      await prisma.courseEnrollment.findUnique({
        where: { memberId_courseId: { memberId: buyerId, courseId: course.id } },
      }),
    ).toBeNull(); // enrollment revoked, exactly as before subscriptions existed
  });
});
