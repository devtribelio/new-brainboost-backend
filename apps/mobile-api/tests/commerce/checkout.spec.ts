import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { buildApp } from '@/app';
import { prisma } from '@bb/db';

describe('commerce checkout flow', () => {
  const app = buildApp();
  const ts = Date.now();
  const email = `checkout-${ts}@test.local`;
  const password = 'secret123';
  let accessToken = '';
  let memberId = '';
  let productId = '';
  const voucherCode = `CO-TEST-${ts}`;
  let voucherId = '';

  beforeAll(async () => {
    await request(app)
      .post('/api/member/auth/register')
      .send({ email, password, fullName: 'Checkout Tester' });
    // Register creates the member inactive (verify-email gate); activate
    // directly — OTP delivery is not what this suite tests.
    await prisma.member.update({
      where: { email },
      data: { isActive: true, isEmailVerified: true },
    });
    const tokenRes = await request(app)
      .post('/api/member/oauth/token')
      .send({ grant_type: 'password', username: email, password });
    accessToken = (tokenRes.body.data as { access_token: string }).access_token;
    const m = await prisma.member.findUnique({ where: { email } });
    memberId = m!.id;

    const product = await prisma.product.create({
      data: {
        type: 'course',
        title: 'Checkout Course',
        price: 500_000,
        isActive: true,
        status: 'active',
      },
    });
    productId = product.id;

    const v = await prisma.voucher.create({
      data: { code: voucherCode, type: 'AMOUNT', value: 50_000, isActive: true },
    });
    voucherId = v.id;
  });

  afterAll(async () => {
    await prisma.commerceTransaction.deleteMany({ where: { memberId } });
    await prisma.voucher.delete({ where: { id: voucherId } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.refreshToken.deleteMany({ where: { memberId } });
    await prisma.member.delete({ where: { id: memberId } });
    await prisma.$disconnect();
  });

  it('POST /product/checkout/submit happy path returns transactionId + breakdown', async () => {
    const r = await request(app)
      .post('/api/member/product/checkout/submit')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ productId });
    expect(r.status).toBe(201);
    expect(r.body.success).toBe(true);
    expect(r.body.data.transactionId).toBeDefined();
    expect(r.body.data.transactionCode).toMatch(/^BB-\d{8}-\d{4}$/);
    expect(r.body.data.itemTotal).toBe(500_000);
    expect(r.body.data.voucherAmount).toBe(0);
    expect(r.body.data.amount).toBe(500_000);

    // tx persisted PENDING
    const tx = await prisma.commerceTransaction.findUnique({
      where: { id: r.body.data.transactionId },
    });
    expect(tx?.status).toBe('PENDING');
    expect(tx?.memberId).toBe(memberId);
    expect(tx?.productId).toBe(productId);
    expect(tx?.expiredAt).not.toBeNull();
  });

  it('applies voucher discount', async () => {
    const r = await request(app)
      .post('/api/member/product/checkout/submit')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ productId, voucherCode });
    expect(r.status).toBe(201);
    expect(r.body.data.voucherAmount).toBe(50_000);
    expect(r.body.data.amount).toBe(450_000);

    const tx = await prisma.commerceTransaction.findUnique({
      where: { id: r.body.data.transactionId },
    });
    expect(tx?.voucherCode).toBe(voucherCode);
    expect(tx?.voucherId).toBe(voucherId);
  });

  it('rejects invalid voucher', async () => {
    const r = await request(app)
      .post('/api/member/product/checkout/submit')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ productId, voucherCode: 'NOT-A-REAL-VOUCHER' });
    expect(r.status).toBe(400);
  });

  it('rejects unknown product', async () => {
    const r = await request(app)
      .post('/api/member/product/checkout/submit')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ productId: '00000000-0000-0000-0000-000000000000' });
    expect(r.status).toBe(404);
  });

  it('requires auth', async () => {
    const r = await request(app)
      .post('/api/member/product/checkout/submit')
      .send({ productId });
    expect(r.status).toBe(401);
  });

  it('validates DTO (missing productId → 400)', async () => {
    const r = await request(app)
      .post('/api/member/product/checkout/submit')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({});
    expect(r.status).toBe(400);
  });

  it('POST /payment/voucher/validate returns voucher meta', async () => {
    const r = await request(app)
      .post('/api/member/payment/voucher/validate')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ code: voucherCode, productId });
    expect(r.status).toBe(200);
    expect(r.body.data.valid).toBe(true);
    expect(r.body.data.voucherAmount).toBe(50_000);
  });
});
