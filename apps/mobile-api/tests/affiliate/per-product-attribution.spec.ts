/**
 * B-5: per-product attribution in AttributionService.resolveOverrideAffiliatorMemberId.
 *
 * AffiliateVisit is per-member; a visit for product X must NOT attribute a purchase
 * of product Y (the "click link for X, buy Y" leak). Precedence per product P:
 *   tier 1 — most recent visit scoped to P
 *   tier 2 — most recent product-less visit (legacy/web/program link)
 *   else   — null (engine falls back to buyer inviter)
 * A visit scoped to a DIFFERENT product never matches.
 *
 * Requires a reachable Postgres test DB (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { AttributionService } from '@bb/domain/affiliate/attribution.service';

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

  it('falls back to a product-less visit when no product-specific one exists', async () => {
    const productZ = await mkProduct();
    await visit(affG, null);
    const r = await svc.resolveOverrideAffiliatorMemberId(buyer, undefined, productZ);
    expect(r).toBe(affG); // tier 2
  });

  it('prefers the exact-product visit over a more recent product-less visit', async () => {
    const productW = await mkProduct();
    const affW = await mkMember();
    // exact-product visit is OLDER; product-less visit is NEWER.
    await visit(affW, productW, new Date(Date.now() - 60 * 60 * 1000));
    await visit(affG, null, new Date());
    const r = await svc.resolveOverrideAffiliatorMemberId(buyer, undefined, productW);
    expect(r).toBe(affW); // tier 1 beats tier 2 regardless of recency
  });
});
