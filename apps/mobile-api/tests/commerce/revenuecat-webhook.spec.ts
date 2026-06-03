import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { buildApp } from '@/app';
import { prisma } from '@bb/db';

const AUTH = 'test-rc-auth';
const ROUTE = '/api/webhook/revenuecat';
const SKU = `com.brainboost.ios.test_${Date.now()}`;

function uid(): string {
  return `rc-${Math.random().toString(36).slice(2, 12)}`;
}

function rcEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    api_version: '1.0',
    event: {
      type: 'INITIAL_PURCHASE',
      id: uid(),
      app_user_id: '',
      product_id: SKU,
      transaction_id: uid(),
      price: 9.99,
      price_in_purchased_currency: 149_000,
      currency: 'IDR',
      ...over,
    },
  };
}

/** Poll until `fn()` returns truthy or the timeout elapses (async listeners). */
async function waitFor<T>(fn: () => Promise<T>, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('RevenueCat webhook', () => {
  const app = buildApp();
  let memberId = '';
  let productId = '';
  let courseId = '';
  let credentialId = '';

  beforeAll(async () => {
    const member = await prisma.member.create({
      data: { email: `rc-${Date.now()}@test.local`, passwordHash: 'x', fullName: 'RC Tester' },
    });
    memberId = member.id;

    // isActive:false keeps this product out of the global `product.list`
    // (isActive:true filter) so it can't pollute other suites' ownership/list
    // counts under parallel execution. Ingest resolveProduct (findUnique by
    // iapProductId) ignores isActive, so the webhook still resolves it.
    const product = await prisma.product.create({
      data: {
        type: 'course',
        title: 'RC Course',
        price: 149_000,
        isActive: false,
        status: 'inactive',
        iapProductId: SKU,
        course: { create: {} },
      },
      include: { course: true },
    });
    productId = product.id;
    courseId = product.course!.id;

    const cred = await prisma.thirdPartyCredential.create({
      data: {
        name: 'revenuecat',
        keyHash: `test-rc-${Date.now()}`,
        isActive: true,
        triggersAffiliate: false,
        canIngestRefund: true,
      },
    });
    credentialId = cred.id;
  });

  afterAll(async () => {
    await prisma.commercePaymentEvent.deleteMany({ where: { payment: { memberId } } });
    await prisma.commercePayment.deleteMany({ where: { memberId } });
    await prisma.commerceTransaction.deleteMany({ where: { memberId } });
    await prisma.courseEnrollment.deleteMany({ where: { memberId } });
    await prisma.member.delete({ where: { id: memberId } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.thirdPartyCredential.delete({ where: { id: credentialId } });
    await prisma.$disconnect();
  });

  it('rejects missing authorization (401)', async () => {
    const r = await request(app).post(ROUTE).send(rcEvent());
    expect(r.status).toBe(401);
  });

  it('rejects wrong authorization (401)', async () => {
    const r = await request(app).post(ROUTE).set('authorization', 'Bearer nope').send(rcEvent());
    expect(r.status).toBe(401);
  });

  it('rejects a malformed body (no event) with 400', async () => {
    const r = await request(app).post(ROUTE).set('authorization', AUTH).send({ api_version: '1.0' });
    expect(r.status).toBe(400);
  });

  it('INITIAL_PURCHASE → committed, tx PAID, grants enrollment (isPurchased)', async () => {
    const body = rcEvent({ app_user_id: memberId });
    const r = await request(app).post(ROUTE).set('authorization', `Bearer ${AUTH}`).send(body);

    expect(r.status).toBe(200);
    expect(r.body.handled).toBe(true);
    expect(r.body.status).toBe('committed');

    const txId = (body.event as { transaction_id: string }).transaction_id;
    const tx = await prisma.commerceTransaction.findUnique({
      where: { provider_providerEventId: { provider: 'revenuecat', providerEventId: txId } },
    });
    expect(tx?.status).toBe('PAID');
    expect(tx?.amount).toBe(149_000);

    // enrollment granted by the async success listener → isPurchased true
    const enrollment = await waitFor(() =>
      prisma.courseEnrollment.findUnique({
        where: { memberId_courseId: { memberId, courseId } },
      }),
    );
    expect(enrollment).not.toBeNull();
  });

  it('idempotent: redelivered event (same transaction_id) → duplicate', async () => {
    const txId = uid();
    const first = rcEvent({ app_user_id: memberId, transaction_id: txId, id: uid() });
    const r1 = await request(app).post(ROUTE).set('authorization', AUTH).send(first);
    expect(r1.body.status).toBe('committed');

    const second = rcEvent({ app_user_id: memberId, transaction_id: txId, id: uid() });
    const r2 = await request(app).post(ROUTE).set('authorization', AUTH).send(second);
    expect(r2.status).toBe(200);
    expect(r2.body.status).toBe('duplicate');

    const count = await prisma.commerceTransaction.count({
      where: { provider: 'revenuecat', providerEventId: txId },
    });
    expect(count).toBe(1);
  });

  it('unknown product_id → product_not_found (no transaction)', async () => {
    const r = await request(app)
      .post(ROUTE)
      .set('authorization', AUTH)
      .send(rcEvent({ app_user_id: memberId, product_id: 'com.brainboost.ios.does_not_exist' }));
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('product_not_found');
  });

  it('unhandled event type (EXPIRATION) → skipped, no ingest', async () => {
    const r = await request(app)
      .post(ROUTE)
      .set('authorization', AUTH)
      .send(rcEvent({ type: 'EXPIRATION', app_user_id: memberId }));
    expect(r.status).toBe(200);
    expect(r.body.handled).toBe(false);
    expect(r.body.status).toBe('skipped');
  });

  it('CANCELLATION → refund: tx REFUNDED + revokes enrollment (isPurchased false)', async () => {
    // 1. purchase
    const txId = uid();
    const purchase = rcEvent({ app_user_id: memberId, transaction_id: txId, id: uid() });
    const rp = await request(app).post(ROUTE).set('authorization', AUTH).send(purchase);
    expect(rp.body.status).toBe('committed');

    await waitFor(() =>
      prisma.courseEnrollment.findUnique({ where: { memberId_courseId: { memberId, courseId } } }),
    );

    // 2. refund references the purchase via transaction_id
    const refund = rcEvent({ type: 'CANCELLATION', app_user_id: memberId, transaction_id: txId, id: uid() });
    const rr = await request(app).post(ROUTE).set('authorization', AUTH).send(refund);
    expect(rr.status).toBe(200);
    expect(rr.body.status).toBe('refunded');

    const tx = await prisma.commerceTransaction.findUnique({
      where: { provider_providerEventId: { provider: 'revenuecat', providerEventId: txId } },
    });
    expect(tx?.status).toBe('REFUNDED');

    // enrollment revoked → isPurchased false
    const enrollment = await prisma.courseEnrollment.findUnique({
      where: { memberId_courseId: { memberId, courseId } },
    });
    expect(enrollment).toBeNull();
  });
});
