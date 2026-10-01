import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { buildApp } from '@/app';
import { prisma } from '@bb/db';
import { serializeBanner } from '@/modules/banner/banner.serializer';

// Unique per run: the suite shares one Postgres with every other spec, so all
// assertions look only at promos carrying this tag.
const TAG = `pp${Date.now().toString(36)}`;
const HOUR = 3600 * 1000;

interface PromoItem {
  slug: string;
  title: string;
  subtitle: string | null;
  voucherCode: string;
  endsAt: string | null;
  products: Array<{ id: string; price: number; promoPrice: number; isPurchased: boolean }>;
}

describe('GET /api/member/promo/public', () => {
  const app = buildApp();
  const email = `${TAG}@test.local`;
  const password = 'secret123';
  let accessToken = '';
  let memberId = '';
  let courseId = '';
  const productIds: string[] = [];
  const voucherIds: string[] = [];
  const promoIds: string[] = [];
  // Promo `ends_at` for the capped-percent promo; the voucher ends an hour sooner.
  const promoEnds = new Date(Date.now() + 48 * HOUR);
  const voucherEnds = new Date(Date.now() + 47 * HOUR);
  let pA = '';
  let pB = '';
  let pC = '';
  let pTicket = '';
  let pInactive = '';

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
        code: `${TAG}-${suffix}`.toUpperCase(),
        type: 'PERCENT',
        value: 30,
        ...data,
        products: { create: scope.map((productId) => ({ productId })) },
      },
    });
    voucherIds.push(v.id);
    return v.id;
  }

  async function promo(
    suffix: string,
    voucherId: string,
    products: string[],
    data: Record<string, unknown> = {},
  ) {
    const p = await prisma.promo.create({
      data: {
        slug: `${TAG}-${suffix}`,
        title: `Promo ${suffix}`,
        voucherId,
        ...data,
        products: { create: products.map((productId, position) => ({ productId, position })) },
      },
    });
    promoIds.push(p.id);
  }

  async function list(token?: string): Promise<PromoItem[]> {
    const req = request(app).get('/api/member/promo/public');
    if (token) req.set('Authorization', `Bearer ${token}`);
    const r = await req;
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    return (r.body.data as PromoItem[]).filter((p) => p.slug.startsWith(TAG));
  }

  const slugs = (items: PromoItem[]) => items.map((p) => p.slug.slice(TAG.length + 1));

  beforeAll(async () => {
    await request(app)
      .post('/api/member/auth/register')
      .send({ email, password, fullName: 'Promo Tester' });
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
    pC = await product('C', 40_000);
    pTicket = await product('Ticket', 100_000, { type: 'event_ticket' });
    pInactive = await product('Inactive', 100_000, { isActive: false });

    // The member owns B.
    const course = await prisma.course.create({ data: { productId: pB } });
    courseId = course.id;
    await prisma.courseEnrollment.create({ data: { memberId, courseId } });

    // 30% capped at 100k, scoped to A + B only; C sits in the promo but outside the voucher.
    const vPercent = await voucher('pct', { maxAmount: 100_000, endsAt: voucherEnds }, [pA, pB]);
    await promo('percent', vPercent, [pB, pA, pC, pTicket, pInactive], {
      position: 2,
      subtitle: 'Sub',
      endsAt: promoEnds,
    });

    // Flat 50k off, global voucher. C costs 40k, so the discount clamps to the price.
    const vAmount = await voucher('amt', { type: 'AMOUNT', value: 50_000 });
    await promo('amount', vAmount, [pA, pC], { position: 1 });

    // Everything below must stay out of the list.
    const far = new Date(Date.now() + 24 * HOUR);
    const past = new Date(Date.now() - HOUR);
    await promo('exhausted', await voucher('exh', { quota: 5, used: 5 }), [pA]);
    await promo('voucher-expired', await voucher('exp', { endsAt: past }), [pA]);
    await promo('voucher-not-started', await voucher('vns', { startsAt: far }), [pA]);
    await promo('voucher-inactive', await voucher('off', { isActive: false }), [pA]);
    await promo('owned', await voucher('own', { ownerMemberId: memberId }), [pA]);
    await promo('campaign', await voucher('cmp', { campaign: 'FIRST_PURCHASE' }), [pA]);
    await promo('trial', await voucher('tri', { type: 'TRIAL', value: 0, trialDays: 7 }), [pA]);
    const vOk = await voucher('ok', {});
    await promo('inactive', vOk, [pA], { isActive: false });
    await promo('not-started', vOk, [pA], { startsAt: far });
    await promo('ended', vOk, [pA], { endsAt: past });
    await promo('no-products', vOk, [pTicket, pInactive]);
    // Voucher covers B only, the promo lists A only → nothing left to show.
    await promo('out-of-scope', await voucher('sco', {}, [pB]), [pA]);
  });

  afterAll(async () => {
    await prisma.promo.deleteMany({ where: { id: { in: promoIds } } });
    await prisma.voucher.deleteMany({ where: { id: { in: voucherIds } } });
    await prisma.courseEnrollment.deleteMany({ where: { memberId } });
    await prisma.course.deleteMany({ where: { id: courseId } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.refreshToken.deleteMany({ where: { memberId } });
    await prisma.member.delete({ where: { id: memberId } });
  });

  it('lists only promos whose voucher anyone could redeem now, ordered by position', async () => {
    expect(slugs(await list())).toEqual(['amount', 'percent']);
  });

  it('breaks a position tie by newest first', async () => {
    const v = await voucher('tie', {});
    await promo('tie', v, [pA], { position: 1 });
    try {
      expect(slugs(await list())).toEqual(['tie', 'amount', 'percent']);
    } finally {
      await prisma.promo.delete({ where: { slug: `${TAG}-tie` } });
    }
  });

  it('PERCENT: floors the discount and applies the cap', async () => {
    const percent = (await list()).find((p) => p.slug.endsWith('-percent'))!;
    expect(percent).toMatchObject({
      title: 'Promo percent',
      subtitle: 'Sub',
      voucherCode: `${TAG}-PCT`.toUpperCase(),
    });
    // B first (promo_products.position), then A. C (outside the voucher's scope), the
    // event ticket and the inactive product are filtered out.
    expect(percent.products.map((p) => p.id)).toEqual([pB, pA]);
    // 30% of 1 000 000 = 300 000 → capped at 100 000.
    expect(percent.products[0]).toMatchObject({ price: 1_000_000, promoPrice: 900_000 });
    // 30% of 298 000 = 89 400, under the cap.
    expect(percent.products[1]).toMatchObject({ price: 298_000, promoPrice: 208_600 });
  });

  it('AMOUNT: flat discount, clamped at the price', async () => {
    const amount = (await list()).find((p) => p.slug.endsWith('-amount'))!;
    expect(amount.subtitle).toBeNull();
    expect(amount.endsAt).toBeNull();
    expect(amount.products.map((p) => [p.id, p.promoPrice])).toEqual([
      [pA, 248_000],
      [pC, 0],
    ]);
  });

  it('endsAt is the earlier of promo and voucher end, in WIB with an offset', async () => {
    const percent = (await list()).find((p) => p.slug.endsWith('-percent'))!;
    expect(percent.endsAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+07:00$/);
    expect(new Date(percent.endsAt!).getTime()).toBe(Math.floor(voucherEnds.getTime() / 1000) * 1000);
  });

  it('returns the catalog item shape plus promoPrice', async () => {
    const promoItem = (await list())[0].products[0] as unknown as Record<string, unknown>;
    const catalog = await request(app).get('/api/member/product/list/public').query({ keyword: TAG });
    const catalogItem = (catalog.body.data as Array<Record<string, unknown>>)[0];
    expect(Object.keys(promoItem).sort()).toEqual([...Object.keys(catalogItem), 'promoPrice'].sort());
  });

  it('guest: nothing is purchased', async () => {
    const all = (await list()).flatMap((p) => p.products);
    expect(all.every((p) => p.isPurchased === false)).toBe(true);
  });

  it('member: an owned product stays in the list with isPurchased true', async () => {
    const percent = (await list(accessToken)).find((p) => p.slug.endsWith('-percent'))!;
    expect(percent.products.map((p) => [p.id, p.isPurchased])).toEqual([
      [pB, true],
      [pA, false],
    ]);
  });

  it('promoPrice equals the checkout quote for the same product and voucher', async () => {
    const percent = (await list(accessToken)).find((p) => p.slug.endsWith('-percent'))!;
    const quote = await request(app)
      .post('/api/member/product/checkout/quote')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ productId: pA, voucherCode: percent.voucherCode });
    expect(quote.status).toBe(200);
    const { itemTotal, voucherAmount } = quote.body.data as { itemTotal: number; voucherAmount: number };
    expect(percent.products.find((p) => p.id === pA)!.promoPrice).toBe(itemTotal - voucherAmount);
  });
});

describe('banner openMode', () => {
  const ids: string[] = [];

  afterAll(async () => {
    await prisma.banner.deleteMany({ where: { id: { in: ids } } });
  });

  it('defaults to external', async () => {
    const b = await prisma.banner.create({ data: { title: `${TAG}-default`, imageUrl: 'x.jpg' } });
    ids.push(b.id);
    expect(serializeBanner(b).openMode).toBe('external');
  });

  it('returns the stored value', async () => {
    const b = await prisma.banner.create({
      data: { title: `${TAG}-webview`, imageUrl: 'x.jpg', openMode: 'webview' },
    });
    ids.push(b.id);
    expect(serializeBanner(b).openMode).toBe('webview');
  });
});
