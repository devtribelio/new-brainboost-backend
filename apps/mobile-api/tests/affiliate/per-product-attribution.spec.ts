/**
 * B-5: per-product attribution in AttributionService.resolveOverrideAffiliatorMemberId.
 *
 * AffiliateVisit is per-member; a visit for product X must NOT attribute a purchase
 * of product Y (the "click link for X, buy Y" leak). STRICT per product P:
 *   - only a visit scoped to P attributes
 *   - product-less visits (productId IS NULL) and other-product visits are IGNORED
 *   - no match → null (engine falls back to buyer inviter)
 *
 * Requires a reachable Postgres test DB (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { AttributionService } from '@bb/domain/affiliate/attribution.service';
import { CheckoutService } from '@bb/domain/commerce/checkout.service';

const TAG = `pp-attr-${Date.now()}`;
const svc = new AttributionService();

describe('AttributionService — per-product visit attribution (B-5)', () => {
  const memberIds: string[] = [];
  const productIds: string[] = [];
  let buyer = '';
  let affX = ''; // promotes product X
  let affY = ''; // promotes product Y
  let affG = ''; // product-less (global) link owner
  let productX = '';
  let productY = '';

  async function mkMember(): Promise<string> {
    const m = await prisma.member.create({
      data: { email: `${TAG}-${randomUUID()}@t.local`, passwordHash: await bcrypt.hash('x', 4) },
    });
    memberIds.push(m.id);
    return m.id;
  }
  async function mkProduct(): Promise<string> {
    const p = await prisma.product.create({ data: { type: 'course', title: `${TAG}-${randomUUID()}`, price: 0 } });
    productIds.push(p.id);
    return p.id;
  }
  async function visit(affiliatorMemberId: string, productId: string | null, createdAt?: Date) {
    await prisma.affiliateVisit.create({
      data: { affiliatorMemberId, memberId: buyer, productId, ...(createdAt ? { createdAt } : {}) },
    });
  }

  beforeAll(async () => {
    buyer = await mkMember();
    affX = await mkMember();
    affY = await mkMember();
    affG = await mkMember();
    productX = await mkProduct();
    productY = await mkProduct();
  });

  afterAll(async () => {
    await prisma.affiliateVisit.deleteMany({ where: { memberId: buyer } });
    if (productIds.length) await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    if (memberIds.length) await prisma.member.deleteMany({ where: { id: { in: memberIds } } });
    await prisma.$disconnect();
  });

  it('attributes a purchase to the visit scoped to that product', async () => {
    await visit(affX, productX);
    const r = await svc.resolveOverrideAffiliatorMemberId(buyer, undefined, productX);
    expect(r).toBe(affX);
  });

  it('does NOT attribute product Y to a visit that was for product X (leak closed)', async () => {
    // Only the productX visit exists from the previous case; buy productY → no match, no product-less visit.
    const r = await svc.resolveOverrideAffiliatorMemberId(buyer, undefined, productY);
    expect(r).toBeNull();
  });

  it('multi-affiliate: each product attributes to its own link owner', async () => {
    await visit(affY, productY);
    const [rx, ry] = await Promise.all([
      svc.resolveOverrideAffiliatorMemberId(buyer, undefined, productX),
      svc.resolveOverrideAffiliatorMemberId(buyer, undefined, productY),
    ]);
    expect(rx).toBe(affX);
    expect(ry).toBe(affY);
  });

  it('IGNORES a product-less visit (strict) — no product-specific visit → null', async () => {
    const productZ = await mkProduct();
    await visit(affG, null); // product-less visit must NOT attribute under strict mode
    const r = await svc.resolveOverrideAffiliatorMemberId(buyer, undefined, productZ);
    expect(r).toBeNull(); // → engine falls back to buyer inviter
  });

  it('uses the exact-product visit even when a more recent product-less visit exists', async () => {
    const productW = await mkProduct();
    const affW = await mkMember();
    // exact-product visit is OLDER; product-less visit is NEWER (and is ignored).
    await visit(affW, productW, new Date(Date.now() - 60 * 60 * 1000));
    await visit(affG, null, new Date());
    const r = await svc.resolveOverrideAffiliatorMemberId(buyer, undefined, productW);
    expect(r).toBe(affW); // product-less visit ignored; exact-product wins
  });
});

/**
 * Subscription plans are ONE attribution group (decided 2026-10-09): the buyer is
 * shown every tier, so a click on any plan attributes a purchase of any plan —
 * in BOTH visit readers. Courses stay strict, in both directions.
 */
describe('Subscription plans = one attribution group', () => {
  const checkout = new CheckoutService() as unknown as {
    resolveAttribution(
      memberId: string,
      productId: string,
    ): Promise<{ affiliatorId: string | null; programId: string | null }>;
  };
  const GTAG = `${TAG}-grp`;
  const memberIds: string[] = [];
  const productIds: string[] = [];
  const programIds: string[] = [];
  let solo = '';
  let family = '';
  let course = '';

  async function mkMember(): Promise<string> {
    const m = await prisma.member.create({
      data: { email: `${GTAG}-${randomUUID()}@t.local`, passwordHash: await bcrypt.hash('x', 4) },
    });
    memberIds.push(m.id);
    return m.id;
  }
  async function mkPlan(tier: string, seatCount: number): Promise<string> {
    const p = await prisma.product.create({
      data: { type: 'subscription', title: `${GTAG}-${tier}`, price: 999_000 },
    });
    productIds.push(p.id);
    await prisma.subscriptionPlan.create({
      data: {
        productId: p.id,
        code: `${GTAG}_${tier}_${randomUUID().slice(0, 8)}`,
        tier,
        periodMonths: 12,
        seatCount,
        affiliateRate: 40,
        renewalAffiliateRate: 10,
      },
    });
    return p.id;
  }
  /** Visit with a program for `productId` the affiliator is enrolled in. */
  async function programVisit(buyer: string, aff: string, productId: string) {
    const program = await prisma.affiliateProgram.create({
      data: { productId, code: `G${randomUUID().slice(0, 7)}`, name: GTAG },
    });
    programIds.push(program.id);
    const affiliator = await prisma.memberAffiliator.create({
      data: { memberId: aff, programId: program.id },
    });
    await prisma.affiliateVisit.create({
      data: { affiliatorMemberId: aff, memberId: buyer, productId, programId: program.id },
    });
    return { programId: program.id, affiliatorId: affiliator.id };
  }

  beforeAll(async () => {
    solo = await mkPlan('SOLO', 1);
    family = await mkPlan('FAMILY', 4);
    const c = await prisma.product.create({ data: { type: 'course', title: `${GTAG}-course`, price: 0 } });
    productIds.push(c.id);
    course = c.id;
  });

  afterAll(async () => {
    await prisma.affiliateVisit.deleteMany({ where: { affiliatorMemberId: { in: memberIds } } });
    if (programIds.length) await prisma.affiliateProgram.deleteMany({ where: { id: { in: programIds } } });
    await prisma.subscriptionPlan.deleteMany({ where: { productId: { in: productIds } } });
    if (productIds.length) await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    if (memberIds.length) await prisma.member.deleteMany({ where: { id: { in: memberIds } } });
  });

  it('a visit on SOLO attributes a FAMILY purchase (both readers)', async () => {
    const buyer = await mkMember();
    const aff = await mkMember();
    const expected = await programVisit(buyer, aff, solo);

    expect(await svc.resolveOverrideAffiliatorMemberId(buyer, undefined, family)).toBe(aff);
    expect(await checkout.resolveAttribution(buyer, family)).toEqual(expected);
  });

  it('a visit on a COURSE does not attribute a subscription purchase', async () => {
    const buyer = await mkMember();
    const aff = await mkMember();
    await programVisit(buyer, aff, course);

    expect(await svc.resolveOverrideAffiliatorMemberId(buyer, undefined, solo)).toBeNull();
    expect(await checkout.resolveAttribution(buyer, solo)).toEqual({ affiliatorId: null, programId: null });
  });

  it('a visit on a subscription plan does not attribute a COURSE purchase', async () => {
    const buyer = await mkMember();
    const aff = await mkMember();
    await programVisit(buyer, aff, family);

    expect(await svc.resolveOverrideAffiliatorMemberId(buyer, undefined, course)).toBeNull();
    expect(await checkout.resolveAttribution(buyer, course)).toEqual({ affiliatorId: null, programId: null });
  });

  it('an own-code visit on a plan is still ignored inside the group', async () => {
    const buyer = await mkMember();
    await prisma.affiliateVisit.create({ data: { affiliatorMemberId: buyer, memberId: buyer, productId: solo } });

    expect(await svc.resolveOverrideAffiliatorMemberId(buyer, undefined, family)).toBeNull();
  });
});
