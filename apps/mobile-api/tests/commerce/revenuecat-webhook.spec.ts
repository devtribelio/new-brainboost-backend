import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { buildApp } from '@/app';
import { prisma } from '@bb/db';
import { CredentialService } from '@/modules/ingest/credential.service';

// Distinct from the env fallback secret (tests/setup REVENUECAT_WEBHOOK_AUTH=
// 'test-rc-auth') on purpose: every request below authenticates via the
// DB-stored credential secret, proving the DB is the source of truth (not env).
const AUTH = 'db-rc-secret-primary';
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
    // iosProductId) ignores isActive, so the webhook still resolves it.
    const product = await prisma.product.create({
      data: {
        type: 'course',
        title: 'RC Course',
        price: 149_000,
        isActive: false,
        status: 'inactive',
        iosProductId: SKU,
        course: { create: {} },
      },
      include: { course: true },
    });
    productId = product.id;
    courseId = product.course!.id;

    const cred = await prisma.thirdPartyCredential.create({
      data: {
        name: 'revenuecat',
        // The webhook shared secret lives here as the credential's keyHash.
        // The guard verifies the Authorization header against it (rotatable).
        keyHash: CredentialService.hash(AUTH),
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

    // No commission/tax fields on this event → accepted mirrors gross
    // (no regression for events that lack the cuts).
    const payment = await prisma.commercePayment.findFirst({ where: { transactionId: tx!.id } });
    expect(payment?.amount).toBe(149_000);
    expect(payment?.acceptedAmount).toBe(149_000);

    // enrollment granted by the async success listener → isPurchased true
    const enrollment = await waitFor(() =>
      prisma.courseEnrollment.findUnique({
        where: { memberId_courseId: { memberId, courseId } },
      }),
    );
    expect(enrollment).not.toBeNull();
  });

  it('uses takehome_percentage when present → acceptedAmount = net settled', async () => {
    // Mirrors a real ID sandbox event: gross 429k, takehome 0.7 → net 300_300.
    // commission/tax also present but takehome is authoritative (RC precomputes
    // regional handling; tax in ID is consumer-paid, not dev-side).
    const body = rcEvent({
      app_user_id: memberId,
      price_in_purchased_currency: 429_000,
      takehome_percentage: 0.7,
      commission_percentage: 0.2703,
      tax_percentage: 0.0991,
    });
    const r = await request(app).post(ROUTE).set('authorization', `Bearer ${AUTH}`).send(body);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('committed');

    const txId = (body.event as { transaction_id: string }).transaction_id;
    const tx = await prisma.commerceTransaction.findUnique({
      where: { provider_providerEventId: { provider: 'revenuecat', providerEventId: txId } },
    });
    // amount (and affiliate base) stays on gross — store fee is Brainboost's cost.
    expect(tx?.amount).toBe(429_000);

    const payment = await prisma.commercePayment.findFirst({ where: { transactionId: tx!.id } });
    expect(payment?.amount).toBe(429_000);
    expect(payment?.acceptedAmount).toBe(300_300);
    // Raw payload persisted for audit / fee reconciliation
    const logRequest = payment?.logRequest as Record<string, unknown> | null;
    expect(logRequest).toBeTruthy();
    expect(logRequest?.takehome_percentage).toBe(0.7);
    expect(logRequest?.commission_percentage).toBe(0.2703);
    expect(logRequest?.product_id).toBe(SKU);
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

  // Kept last: it rotates the credential's keyHash, invalidating AUTH for any
  // subsequent request.
  it('rotated secret: old key rejected (401), new key authorizes', async () => {
    const NEW = 'db-rc-secret-rotated';
    await prisma.thirdPartyCredential.update({
      where: { id: credentialId },
      data: { keyHash: CredentialService.hash(NEW) },
    });

    // Old secret no longer matches the DB; the env fallback ('test-rc-auth')
    // also differs → 401. Proves rotation takes effect with no redeploy.
    const old = await request(app)
      .post(ROUTE)
      .set('authorization', AUTH)
      .send(rcEvent({ type: 'EXPIRATION', app_user_id: memberId }));
    expect(old.status).toBe(401);

    // New secret authorizes (EXPIRATION → 200 skipped proves auth passed).
    const fresh = await request(app)
      .post(ROUTE)
      .set('authorization', `Bearer ${NEW}`)
      .send(rcEvent({ type: 'EXPIRATION', app_user_id: memberId }));
    expect(fresh.status).toBe(200);
    expect(fresh.body.status).toBe('skipped');
  });
});
