/**
 * Clickable affiliate link `GET /api/member/affiliate/link/:affCode/:product`
 * (OneLink `af_web_dp` + direct share): logs the visit, sets `bb_aff`, and
 * ALWAYS 302s — never an error page for someone who clicked a link.
 *
 * Requires a reachable Postgres test DB (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { signAccessToken } from '@bb/common/utils/jwt.util';
import { AFFILIATE_COOKIE_NAME } from '@bb/domain/affiliate/constants';
import { shopBaseUrl } from '@bb/domain/shop/shop-base-url';
import { VisitService } from '@bb/domain/affiliate/visit.service';
import { buildApp } from '../../src/app';

const app = buildApp();
const TAG = `aff-link-${Date.now()}`;
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

function code(len: number): string {
  return randomUUID().replace(/-/g, '').slice(0, len).toUpperCase();
}

function bbAffCookie(res: request.Response): string | undefined {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  return raw?.find((c) => c.startsWith(`${AFFILIATE_COOKIE_NAME}=`));
}

describe('GET /api/member/affiliate/link/:affCode/:product', () => {
  const memberIds: string[] = [];
  let base = '';
  let affiliator = { id: '', affiliateCode: '' };
  let product = { id: '', code: '' };

  beforeAll(async () => {
    base = await shopBaseUrl();
    const m = await prisma.member.create({
      data: {
        email: `${TAG}-${randomUUID()}@t.local`,
        passwordHash: await bcrypt.hash('x', 4),
        affiliateCode: code(6),
      },
      select: { id: true, affiliateCode: true },
    });
    memberIds.push(m.id);
    affiliator = { id: m.id, affiliateCode: m.affiliateCode! };
    const p = await prisma.product.create({
      data: { type: 'course', title: `${TAG}-product`, price: 298_000, code: code(10) },
      select: { id: true, code: true },
    });
    product = { id: p.id, code: p.code! };
  });

  afterAll(async () => {
    await prisma.affiliateVisit.deleteMany({ where: { affiliatorMemberId: { in: memberIds } } });
    await prisma.refreshToken.deleteMany({ where: { memberId: { in: memberIds } } });
    await prisma.member.deleteMany({ where: { id: { in: memberIds } } });
    if (product.id) await prisma.product.deleteMany({ where: { id: product.id } });
  });

  it('valid code + product → 302 to the shop product page, visit row, bb_aff cookie', async () => {
    const res = await request(app)
      .get(
        `/api/member/affiliate/link/${affiliator.affiliateCode}/${product.code}?utm_source=onelink`,
      )
      .set('User-Agent', BROWSER_UA)
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${base}/product/${product.code}`);
    expect(bbAffCookie(res)).toContain(`${AFFILIATE_COOKIE_NAME}=${affiliator.affiliateCode}`);

    const visits = await prisma.affiliateVisit.findMany({
      where: { affiliatorMemberId: affiliator.id, productId: product.id },
    });
    expect(visits).toHaveLength(1);
    expect(visits[0]!.memberId).toBeNull();
    expect(visits[0]!.utmSource).toBe('onelink');
  });

  it('unknown affiliate code → 302 to the product page, no cookie, no visit', async () => {
    const before = await prisma.affiliateVisit.count({ where: { productId: product.id } });
    const res = await request(app)
      .get(`/api/member/affiliate/link/NOPE${code(4)}/${product.code}`)
      .set('User-Agent', BROWSER_UA)
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${base}/product/${product.code}`);
    expect(bbAffCookie(res)).toBeUndefined();
    expect(await prisma.affiliateVisit.count({ where: { productId: product.id } })).toBe(before);
  });

  it('unknown product → 302 to /products', async () => {
    const res = await request(app)
      .get(`/api/member/affiliate/link/${affiliator.affiliateCode}/no-such-product-${TAG}`)
      .set('User-Agent', BROWSER_UA)
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${base}/products`);
  });

  it('bot / unfurl user agent → 302, no visit, no cookie', async () => {
    const before = await prisma.affiliateVisit.count({
      where: { affiliatorMemberId: affiliator.id },
    });
    const res = await request(app)
      .get(`/api/member/affiliate/link/${affiliator.affiliateCode}/${product.code}`)
      .set('User-Agent', 'WhatsApp/2.23.20.0 A')
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${base}/product/${product.code}`);
    expect(bbAffCookie(res)).toBeUndefined();
    expect(
      await prisma.affiliateVisit.count({ where: { affiliatorMemberId: affiliator.id } }),
    ).toBe(before);
  });

  it('own code with a bearer → 302, no cookie, no visit', async () => {
    const session = await prisma.refreshToken.create({
      data: {
        memberId: affiliator.id,
        token: `${TAG}-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const token = signAccessToken({ sub: affiliator.id, email: 'x@t.local', sid: session.id });
    const before = await prisma.affiliateVisit.count({
      where: { affiliatorMemberId: affiliator.id },
    });

    const res = await request(app)
      .get(`/api/member/affiliate/link/${affiliator.affiliateCode}/${product.code}`)
      .set('User-Agent', BROWSER_UA)
      .set('Authorization', `Bearer ${token}`)
      .redirects(0);

    expect(res.status).toBe(302);
    expect(bbAffCookie(res)).toBeUndefined();
    expect(
      await prisma.affiliateVisit.count({ where: { affiliatorMemberId: affiliator.id } }),
    ).toBe(before);
  });

  it('POST /product/course/share returns affiliateLinkUrl for an affiliate', async () => {
    const session = await prisma.refreshToken.create({
      data: {
        memberId: affiliator.id,
        token: `${TAG}-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const token = signAccessToken({ sub: affiliator.id, email: 'x@t.local', sid: session.id });

    const res = await request(app)
      .post('/api/member/product/course/share')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: product.code });

    expect(res.status).toBe(200);
    expect(res.body.data.affiliateLinkUrl).toBe(
      `${base}/api/member/affiliate/link/${affiliator.affiliateCode}/${product.code}`,
    );
    expect(typeof res.body.data.shareUrl).toBe('string');
  });
});

/**
 * Group link ref `subscription`: resolves to the default plan (active, fewest
 * seats, lower price on a tie). Fixtures use seatCount 0 so they sort ahead of
 * every real plan in a shared test DB.
 */
describe('affiliate link ref `subscription` (subscription group)', () => {
  const memberIds: string[] = [];
  const productIds: string[] = [];
  let base = '';
  let affiliator = { id: '', affiliateCode: '' };
  let defaultPlan = { id: '', code: '' };
  let otherPlan = '';

  async function mkPlan(tier: string, price: number, isActive = true) {
    const p = await prisma.product.create({
      data: { type: 'subscription', title: `${TAG}-${tier}`, price, code: code(10) },
      select: { id: true, code: true },
    });
    productIds.push(p.id);
    await prisma.subscriptionPlan.create({
      data: {
        productId: p.id,
        code: `${TAG}_${tier}_${code(6)}`,
        tier,
        periodMonths: 12,
        seatCount: 0,
        affiliateRate: 40,
        renewalAffiliateRate: 10,
        isActive,
      },
    });
    return { id: p.id, code: p.code! };
  }
  async function bearer(memberId: string): Promise<string> {
    const session = await prisma.refreshToken.create({
      data: { memberId, token: `${TAG}-${randomUUID()}`, expiresAt: new Date(Date.now() + 86_400_000) },
    });
    return signAccessToken({ sub: memberId, email: 'x@t.local', sid: session.id });
  }

  beforeAll(async () => {
    base = await shopBaseUrl();
    const m = await prisma.member.create({
      data: {
        email: `${TAG}-${randomUUID()}@t.local`,
        passwordHash: await bcrypt.hash('x', 4),
        affiliateCode: code(6),
      },
      select: { id: true, affiliateCode: true },
    });
    memberIds.push(m.id);
    affiliator = { id: m.id, affiliateCode: m.affiliateCode! };
    await mkPlan('INACTIVE', 0, false); // cheapest, but inactive → never the default
    defaultPlan = await mkPlan('DEFAULT', 1);
    otherPlan = (await mkPlan('PRICIER', 2)).id; // same seats, higher price → loses the tie
  });

  afterAll(async () => {
    await prisma.affiliateVisit.deleteMany({ where: { affiliatorMemberId: { in: memberIds } } });
    await prisma.refreshToken.deleteMany({ where: { memberId: { in: memberIds } } });
    await prisma.subscriptionPlan.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.member.deleteMany({ where: { id: { in: memberIds } } });
    await prisma.$disconnect();
  });

  it('resolveProduct("subscription") → the default plan, case-insensitive', async () => {
    const svc = new VisitService();
    expect((await svc.resolveProduct('subscription'))?.id).toBe(defaultPlan.id);
    expect((await svc.resolveProduct('Subscription'))?.id).toBe(defaultPlan.id);
  });

  it('GET /link/<aff>/subscription → 302 to the default plan page, visit on the default plan, cookie', async () => {
    const res = await request(app)
      .get(`/api/member/affiliate/link/${affiliator.affiliateCode}/subscription`)
      .set('User-Agent', BROWSER_UA)
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${base}/product/${defaultPlan.code}`);
    expect(bbAffCookie(res)).toContain(`${AFFILIATE_COOKIE_NAME}=${affiliator.affiliateCode}`);
    expect(
      await prisma.affiliateVisit.count({ where: { affiliatorMemberId: affiliator.id, productId: defaultPlan.id } }),
    ).toBe(1);
  });

  it('POST /affiliate/visits productCode "subscription" → visit on the default plan', async () => {
    const res = await request(app)
      .post('/api/member/affiliate/visits')
      .send({ affiliatorCode: affiliator.affiliateCode, productCode: 'subscription', clientEventId: randomUUID() });

    expect(res.status).toBe(200);
    expect(
      await prisma.affiliateVisit.count({ where: { affiliatorMemberId: affiliator.id, productId: defaultPlan.id } }),
    ).toBe(2);
  });

  it('POST /product/course/share on a subscription plan → affiliateLinkUrl is the group link', async () => {
    const otherCode = (await prisma.product.findUniqueOrThrow({ where: { id: otherPlan } })).code!;
    const res = await request(app)
      .post('/api/member/product/course/share')
      .set('Authorization', `Bearer ${await bearer(affiliator.id)}`)
      .send({ code: otherCode });

    expect(res.status).toBe(200);
    expect(res.body.data.affiliateLinkUrl).toBe(
      `${base}/api/member/affiliate/link/${affiliator.affiliateCode}/subscription`,
    );
  });

  it('POST /product/course/share with code "subscription" → group link (plans list has no product code)', async () => {
    const res = await request(app)
      .post('/api/member/product/course/share')
      .set('Authorization', `Bearer ${await bearer(affiliator.id)}`)
      .send({ code: 'subscription' });

    expect(res.status).toBe(200);
    expect(res.body.data.affiliateLinkUrl).toBe(
      `${base}/api/member/affiliate/link/${affiliator.affiliateCode}/subscription`,
    );
  });
});
