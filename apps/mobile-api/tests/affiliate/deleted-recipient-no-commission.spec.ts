/**
 * A soft-deleted account earns no commission — and everyone else keeps their level.
 *
 * Both halves matter, and the second is the reason this test exists. The obvious
 * implementation of "stop paying a deleted member" is to NULL their downline's
 * `inviter_id` at purge time. That does far more than intended: `commitCommissions-
 * ForPayment` seeds the chain from `buyer.inviterId`, so clearing it makes the
 * function return before the walk even starts, and every upline ABOVE the deleted
 * member silently stops earning on that downline forever.
 *
 * So the deleted node stays IN the chain and only its payout row is skipped. The
 * level assertions below are what pin that down: L2 must still be 10%, not 20%.
 *
 * Requires a reachable Postgres test DB (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { AffiliatorService } from '@bb/domain/affiliate/affiliator.service';

const TAG = `deleted-comm-${Date.now()}`;
const svc = new AffiliatorService();
const PRICE = 1_000_000;

describe('affiliate commission — soft-deleted recipients', () => {
  const memberIds: string[] = [];
  let productId = '';
  // grandparent ← parent ← seed ← buyer
  let grandparent = '';
  let parent = '';
  let seed = '';
  let buyer = '';

  async function mkMember(inviterId: string | null): Promise<string> {
    const m = await prisma.member.create({
      data: {
        email: `${TAG}-${randomUUID()}@t.local`,
        passwordHash: await bcrypt.hash('x', 4),
        // GROWTH so the multitier ladder applies at every level (20/10/5/5);
        // PERFORMANCE pays level 1 only and would not show a level shift at all.
        affiliateBased: 'GROWTH',
        inviterId,
      },
    });
    memberIds.push(m.id);
    return m.id;
  }

  beforeAll(async () => {
    const product = await prisma.product.create({
      data: { type: 'course', title: `${TAG}-course`, price: PRICE },
    });
    productId = product.id;

    grandparent = await mkMember(null);
    parent = await mkMember(grandparent);
    seed = await mkMember(parent);
    buyer = await mkMember(seed);
  });

  afterAll(async () => {
    await prisma.affiliateCommission.deleteMany({ where: { buyerMemberId: buyer } });
    await prisma.product.deleteMany({ where: { id: productId } });
    if (memberIds.length) await prisma.member.deleteMany({ where: { id: { in: memberIds } } });
  });

  async function commit(): Promise<Map<string, number>> {
    const paymentId = randomUUID();
    await svc.commitCommissionsForPayment({
      paymentId,
      productId,
      productPrice: PRICE,
      voucherAmount: 0,
      buyerMemberId: buyer,
      programId: null,
    });
    const rows = await prisma.affiliateCommission.findMany({ where: { paymentId } });
    return new Map(rows.map((r) => [r.recipientId, r.amount]));
  }

  it('pays the whole ladder while every member is live', async () => {
    const paid = await commit();
    expect(paid.get(seed)).toBe(200_000); // L1 20%
    expect(paid.get(parent)).toBe(100_000); // L2 10%
    expect(paid.get(grandparent)).toBe(50_000); // L3 5%
  });

  it('skips the deleted member and leaves every other level untouched', async () => {
    await prisma.member.update({ where: { id: seed }, data: { deletedAt: new Date() } });

    const paid = await commit();

    // The deleted account cannot log in, pass KYC or request a payout, so a row
    // written to it is a liability that can never be settled.
    expect(paid.has(seed)).toBe(false);
    // …and the two above it keep the exact rates they had. If the chain had been
    // severed instead, both of these would be absent; if the deleted node had been
    // dropped from the chain, `parent` would have been promoted to 200_000.
    expect(paid.get(parent)).toBe(100_000);
    expect(paid.get(grandparent)).toBe(50_000);
  });
});
