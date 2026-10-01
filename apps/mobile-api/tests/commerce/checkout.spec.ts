import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { buildApp } from '@/app';
import { prisma } from '@bb/db';
import { SETTING_KEYS, SettingsService, settingsService } from '@bb/common/services/settings.service';

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
    // The `-XXXX` tail is optional and documented: `generateOrderCode` derives its
    // sequence from a per-day COUNT, so two inserts in the same instant collide on
    // `code` and the retry appends jitter. Pinning the clean form made this assert
    // on how busy the suite happened to be, not on the code's shape.
    expect(r.body.data.transactionCode).toMatch(/^BB-\d{8}-\d{4}(-[0-9A-F]{4})?$/);
    expect(r.body.data.itemTotal).toBe(500_000);
    expect(r.body.data.voucherAmount).toBe(0);
    // Tax fields are always present; with no rate configured they read 0 and
    // the total is exactly what it was before tax existed.
    expect(r.body.data.taxRate).toBe(0);
    expect(r.body.data.taxAmount).toBe(0);
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

  describe('POST /product/checkout/quote', () => {
    it('prices the checkout without writing an order or touching the voucher', async () => {
      const before = await prisma.commerceTransaction.count({ where: { memberId } });
      const usedBefore = (await prisma.voucher.findUnique({ where: { id: voucherId } }))!.used;

      const r = await request(app)
        .post('/api/member/product/checkout/quote')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ productId, voucherCode });
      expect(r.status).toBe(200);
      expect(r.body.data).toEqual({
        itemTotal: 500_000,
        voucherAmount: 50_000,
        taxRate: 0,
        taxAmount: 0,
        amount: 450_000,
      });
      expect(r.body.data.transactionId).toBeUndefined();

      expect(await prisma.commerceTransaction.count({ where: { memberId } })).toBe(before);
      expect((await prisma.voucher.findUnique({ where: { id: voucherId } }))!.used).toBe(usedBefore);
    });

    it('refuses an invalid voucher exactly as submit does', async () => {
      const r = await request(app)
        .post('/api/member/product/checkout/quote')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ productId, voucherCode: 'NOT-A-REAL-VOUCHER' });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('VOUCHER_INVALID');
    });

    it('requires auth', async () => {
      const r = await request(app).post('/api/member/product/checkout/quote').send({ productId });
      expect(r.status).toBe(401);
    });
  });

  it('a configured rate bills nothing while tax.enabled is off', async () => {
    try {
      await settingsService.set(SETTING_KEYS.taxRate, '11');
      SettingsService.clearCache();
      const r = await request(app)
        .post('/api/member/product/checkout/quote')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ productId });
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ taxRate: 0, taxAmount: 0, amount: 500_000 });
    } finally {
      await prisma.appSetting.deleteMany({ where: { key: SETTING_KEYS.taxRate } });
      SettingsService.clearCache();
    }
  });

  describe('with tax.enabled = true, tax.rate = 11', () => {
    beforeAll(async () => {
      await settingsService.set(SETTING_KEYS.taxEnabled, 'true');
      await settingsService.set(SETTING_KEYS.taxRate, '11');
      SettingsService.clearCache();
    });
    afterAll(async () => {
      await prisma.appSetting.deleteMany({
        where: { key: { in: [SETTING_KEYS.taxEnabled, SETTING_KEYS.taxRate] } },
      });
      SettingsService.clearCache();
    });

    it('T-12 quote and submit bill the same tax-inclusive total, frozen on the order', async () => {
      const quote = await request(app)
        .post('/api/member/product/checkout/quote')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ productId, voucherCode });
      expect(quote.status).toBe(200);
      // (500_000 − 50_000) × 11% = 49_500
      expect(quote.body.data).toEqual({
        itemTotal: 500_000,
        voucherAmount: 50_000,
        taxRate: 11,
        taxAmount: 49_500,
        amount: 499_500,
      });

      const submit = await request(app)
        .post('/api/member/product/checkout/submit')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ productId, voucherCode });
      expect(submit.status).toBe(201);
      expect(submit.body.data).toMatchObject(quote.body.data);

      const tx = await prisma.commerceTransaction.findUnique({
        where: { id: submit.body.data.transactionId },
      });
      expect(tx).toMatchObject({ itemTotal: 500_000, voucherAmount: 50_000, taxRate: 11, taxAmount: 49_500, amount: 499_500 });

      // Detail renders the same card as checkout did.
      const detail = await request(app)
        .get(`/api/member/payment/commerce/${tx!.id}`)
        .set('Authorization', `Bearer ${accessToken}`);
      expect(detail.status).toBe(200);
      expect(detail.body.data).toMatchObject({
        itemTotal: 500_000,
        voucherAmount: 50_000,
        taxRate: 11,
        taxAmount: 49_500,
        amount: 499_500,
      });

      // And a rate change afterwards never moves an order already placed.
      await settingsService.set(SETTING_KEYS.taxRate, '12');
      SettingsService.clearCache();
      const again = await request(app)
        .get(`/api/member/payment/commerce/${tx!.id}`)
        .set('Authorization', `Bearer ${accessToken}`);
      expect(again.body.data.taxRate).toBe(11);
      expect(again.body.data.amount).toBe(499_500);
    });

    it('T-09 an order placed before tax lists with taxAmount 0 and its old total', async () => {
      const legacy = await prisma.commerceTransaction.create({
        data: {
          code: `BB-TAXLEGACY-${ts}`,
          memberId,
          productId,
          itemTotal: 500_000,
          amount: 500_000,
          status: 'PAID',
        },
      });
      const list = await request(app)
        .get('/api/member/payment/commerce/list')
        .set('Authorization', `Bearer ${accessToken}`)
        .query({ status: 'PAID' });
      expect(list.status).toBe(200);
      const row = (list.body.data as Array<{ id: string; taxRate: number; taxAmount: number; amount: number }>)
        .find((r) => r.id === legacy.id);
      expect(row).toMatchObject({ taxRate: 0, taxAmount: 0, amount: 500_000 });
    });
  });
});
