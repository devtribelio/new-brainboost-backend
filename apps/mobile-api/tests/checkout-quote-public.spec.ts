import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { buildApp } from '@/app';
import { prisma } from '@bb/db';
import { SETTING_KEYS, SettingsService, settingsService } from '@bb/common/services/settings.service';

// Unique per run: the suite shares one Postgres with every other spec.
const TAG = `pq${Date.now().toString(36)}`;
const HOUR = 3600 * 1000;
const PUBLIC = '/api/member/product/checkout/quote/public';
const AUTHED = '/api/member/product/checkout/quote';
const UNKNOWN_PRODUCT = '00000000-0000-0000-0000-000000000000';

describe('POST /api/member/product/checkout/quote/public', () => {
  const app = buildApp();
  const email = `${TAG}@test.local`;
  const password = 'secret123';
  let accessToken = '';
  let memberId = '';
  let courseId = '';
  const productIds: string[] = [];
  const voucherIds: string[] = [];
  let pA = '';
  let pB = '';
  let pOwned = '';
  let pInactive = '';

  const code = (suffix: string) => `${TAG}-${suffix}`.toUpperCase();

  async function product(title: string, price: number, extra: Record<string, unknown> = {}) {
    const p = await prisma.product.create({
      data: { type: 'course', title: `${TAG} ${title}`, price, isActive: true, status: 'active', ...extra },
    });
    productIds.push(p.id);
    return p.id;
  }

  async function voucher(suffix: string, data: Record<string, unknown>, scope: string[] = []) {
    const v = await prisma.voucher.create({
      data: {
        code: code(suffix),
        type: 'PERCENT',
        value: 30,
        ...data,
        products: { create: scope.map((productId) => ({ productId })) },
      },
    });
    voucherIds.push(v.id);
    return v.id;
  }

  const guest = (body: Record<string, unknown>) => request(app).post(PUBLIC).send(body);
  const member = (body: Record<string, unknown>) =>
    request(app).post(AUTHED).set('Authorization', `Bearer ${accessToken}`).send(body);

  /** The public quote must be the authed quote, byte for byte. */
  async function expectSameAsAuthed(body: Record<string, unknown>) {
    const [pub, authed] = [await guest(body), await member(body)];
    expect(authed.status).toBe(200);
    expect(pub.status).toBe(200);
    expect(pub.body).toEqual(authed.body);
    return pub.body.data as {
      itemTotal: number;
      voucherAmount: number;
      taxRate: number;
      taxAmount: number;
      amount: number;
    };
  }

  beforeAll(async () => {
    await request(app)
      .post('/api/member/auth/register')
      .send({ email, password, fullName: 'Public Quote Tester' });
    await prisma.member.update({
      where: { email },
      data: { isActive: true, isEmailVerified: true },
    });
    const tokenRes = await request(app)
      .post('/api/member/oauth/token')
      .send({ grant_type: 'password', username: email, password });
    accessToken = (tokenRes.body.data as { access_token: string }).access_token;
    memberId = (await prisma.member.findUnique({ where: { email } }))!.id;

    pA = await product('A', 298_000);
    pB = await product('B', 1_000_000);
    pOwned = await product('Owned', 500_000);
    pInactive = await product('Inactive', 100_000, { isActive: false });

    const course = await prisma.course.create({ data: { productId: pOwned } });
    courseId = course.id;
    await prisma.courseEnrollment.create({ data: { memberId, courseId } });

    const far = new Date(Date.now() + 24 * HOUR);
    const past = new Date(Date.now() - HOUR);
    await voucher('pct', { maxAmount: 100_000 });
    await voucher('amt', { type: 'AMOUNT', value: 50_000 });
    await voucher('off', { isActive: false });
    await voucher('exp', { endsAt: past });
    await voucher('vns', { startsAt: far });
    await voucher('exh', { quota: 5, used: 5 });
    await voucher('sco', {}, [pB]);
    await voucher('own', { ownerMemberId: memberId });
    await voucher('ownexp', { ownerMemberId: memberId, campaign: `${TAG}-c1`, endsAt: past });
    await voucher('cmp', { campaign: `${TAG}-c2` });
    await voucher('tri', { type: 'TRIAL', value: 0, trialDays: 7 });
  });

  afterAll(async () => {
    await prisma.voucher.deleteMany({ where: { id: { in: voucherIds } } });
    await prisma.commerceTransaction.deleteMany({ where: { memberId } });
    await prisma.courseEnrollment.deleteMany({ where: { memberId } });
    await prisma.course.deleteMany({ where: { id: courseId } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.refreshToken.deleteMany({ where: { memberId } });
    await prisma.member.delete({ where: { id: memberId } });
  });

  describe('with tax off', () => {
    it('no voucher: equals the authed quote', async () => {
      const data = await expectSameAsAuthed({ productId: pA });
      expect(data).toEqual({ itemTotal: 298_000, voucherAmount: 0, taxRate: 0, taxAmount: 0, amount: 298_000 });
    });

    it('PERCENT under the cap: equals the authed quote', async () => {
      // 30% of 298 000 = 89 400.
      const data = await expectSameAsAuthed({ productId: pA, voucherCode: code('pct') });
      expect(data).toMatchObject({ voucherAmount: 89_400, amount: 208_600 });
    });

    it('PERCENT over the cap: equals the authed quote', async () => {
      // 30% of 1 000 000 = 300 000 → capped at 100 000.
      const data = await expectSameAsAuthed({ productId: pB, voucherCode: code('pct') });
      expect(data).toMatchObject({ voucherAmount: 100_000, amount: 900_000 });
    });

    it('AMOUNT: equals the authed quote', async () => {
      const data = await expectSameAsAuthed({ productId: pA, voucherCode: code('amt') });
      expect(data).toMatchObject({ voucherAmount: 50_000, amount: 248_000 });
    });
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

    it('no voucher: equals the authed quote', async () => {
      // 298 000 × 11% = 32 780.
      const data = await expectSameAsAuthed({ productId: pA });
      expect(data).toEqual({
        itemTotal: 298_000,
        voucherAmount: 0,
        taxRate: 11,
        taxAmount: 32_780,
        amount: 330_780,
      });
    });

    it('PERCENT with a cap: tax on the discounted price, equals the authed quote', async () => {
      // (1 000 000 − 100 000) × 11% = 99 000.
      const data = await expectSameAsAuthed({ productId: pB, voucherCode: code('pct') });
      expect(data).toEqual({
        itemTotal: 1_000_000,
        voucherAmount: 100_000,
        taxRate: 11,
        taxAmount: 99_000,
        amount: 999_000,
      });
    });

    it('AMOUNT: tax on the discounted price, equals the authed quote', async () => {
      // (298 000 − 50 000) × 11% = 27 280.
      const data = await expectSameAsAuthed({ productId: pA, voucherCode: code('amt') });
      expect(data).toEqual({
        itemTotal: 298_000,
        voucherAmount: 50_000,
        taxRate: 11,
        taxAmount: 27_280,
        amount: 275_280,
      });
    });
  });

  describe('voucher refused', () => {
    it.each([
      ['unknown code', 'nope'],
      ['inactive', 'off'],
      ['expired', 'exp'],
      ['not started', 'vns'],
      ['quota exhausted', 'exh'],
      ['product outside the whitelist', 'sco'],
    ])('%s → 400 VOUCHER_INVALID with a reason', async (_label, suffix) => {
      const r = await guest({ productId: pA, voucherCode: code(suffix) });
      expect(r.status).toBe(400);
      expect(r.body.success).toBe(false);
      expect(r.body.error.code).toBe('VOUCHER_INVALID');
      expect(typeof r.body.error.details.reason).toBe('string');
      expect(r.body.data ?? null).toBeNull();
    });

    it('a whitelisted voucher still prices the product it covers', async () => {
      await expectSameAsAuthed({ productId: pB, voucherCode: code('sco') });
    });

    // The one fact the ownership rule hides is that the code exists. Any difference
    // from the unknown-code answer — status, code, wording — is an oracle.
    it.each([
      ['owned', 'own'],
      ['owned and expired', 'ownexp'],
      ['campaign', 'cmp'],
    ])('%s voucher answers exactly like a code that does not exist', async (_label, suffix) => {
      const unknown = await guest({ productId: pA, voucherCode: code('nope') });
      const r = await guest({ productId: pA, voucherCode: code(suffix) });
      expect(r.status).toBe(unknown.status);
      expect(r.body).toEqual(unknown.body);
    });

    it('owned voucher stays hidden even when the request carries its owner\'s bearer', async () => {
      const unknown = await guest({ productId: pA, voucherCode: code('nope') });
      const r = await request(app)
        .post(PUBLIC)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ productId: pA, voucherCode: code('own') });
      expect(r.status).toBe(unknown.status);
      expect(r.body).toEqual(unknown.body);
    });

    it('TRIAL → 400 telling the visitor to log in, no price', async () => {
      const r = await guest({ productId: pA, voucherCode: code('tri') });
      expect(r.status).toBe(400);
      expect(r.body.success).toBe(false);
      expect(r.body.error.details.reason).toMatch(/login|masuk/i);
      expect(r.body.data ?? null).toBeNull();
    });
  });

  describe('product problems answer as the authed quote does', () => {
    it.each([
      ['unknown product', () => UNKNOWN_PRODUCT],
      ['inactive product', () => pInactive],
    ])('%s', async (_label, id) => {
      const [pub, authed] = [await guest({ productId: id() }), await member({ productId: id() })];
      expect(authed.status).toBeGreaterThanOrEqual(400);
      expect(pub.status).toBe(authed.status);
      expect(pub.body.error.code).toBe(authed.body.error.code);
    });

    it('missing productId → 400', async () => {
      expect((await guest({})).status).toBe(400);
    });
  });

  it('a product the member already owns: public still quotes, authed refuses', async () => {
    const authed = await member({ productId: pOwned });
    expect(authed.status).toBe(400);
    expect(authed.body.error.code).toBe('PRODUCT_ALREADY_PURCHASED');

    const pub = await guest({ productId: pOwned });
    expect(pub.status).toBe(200);
    expect(pub.body.data).toMatchObject({ itemTotal: 500_000, voucherAmount: 0, amount: 500_000 });

    // The owned-guard is member-specific; a bearer on the public route does not turn it on.
    const pubWithBearer = await request(app)
      .post(PUBLIC)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ productId: pOwned });
    expect(pubWithBearer.status).toBe(200);
    expect(pubWithBearer.body).toEqual(pub.body);
  });

  it.each([
    ['garbage bearer', 'Bearer not-a-jwt'],
    ['malformed header', 'garbage'],
  ])('%s → 200, never 401', async (_label, header) => {
    const plain = await guest({ productId: pA, voucherCode: code('pct') });
    const r = await request(app)
      .post(PUBLIC)
      .set('Authorization', header)
      .send({ productId: pA, voucherCode: code('pct') });
    expect(r.status).toBe(200);
    expect(r.body).toEqual(plain.body);
  });

  it('writes nothing: voucher usage and orders are untouched', async () => {
    const snapshot = async () => ({
      vouchers: await prisma.voucher.findMany({
        where: { id: { in: voucherIds } },
        select: { id: true, used: true, updatedAt: true },
        orderBy: { id: 'asc' },
      }),
      redemptions: await prisma.voucherRedemption.count({ where: { voucherId: { in: voucherIds } } }),
      transactions: await prisma.commerceTransaction.count({ where: { productId: { in: productIds } } }),
    });
    const before = await snapshot();

    for (const suffix of ['pct', 'amt', 'exh', 'own', 'tri', 'nope']) {
      await guest({ productId: pA, voucherCode: code(suffix) });
    }
    await guest({ productId: pA });

    expect(await snapshot()).toEqual(before);
  });
});
