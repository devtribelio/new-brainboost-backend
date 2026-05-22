/**
 * Per-purchase attribution model: A permanent (inviter) + per-purchase link override.
 *  - No override  → commission goes to the buyer's permanent inviter (A).
 *  - With override → commission goes to the link owner (C) for that purchase only.
 * Program is optional (Option B): commission fires for any product.
 * Requires a reachable Postgres test DB (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@/config/prisma';
import { AffiliatorService } from '@/modules/affiliate/affiliator.service';

const TAG = `attr-${Date.now()}`;
const svc = new AffiliatorService();

describe('affiliate attribution — inviter default + per-purchase link override', () => {
  const ids: string[] = [];
  let productId = '';
  let A = ''; // permanent inviter
  let B = ''; // buyer (inviterId = A)
  let C = ''; // a different affiliator (link owner)

  async function mkMember(inviterId: string | null): Promise<string> {
    const m = await prisma.member.create({
      data: {
        email: `${TAG}-${randomUUID()}@t.local`,
        passwordHash: await bcrypt.hash('x', 4),
        affiliateBased: 'PERFORMANCE',
        inviterId,
      },
    });
    ids.push(m.id);
    return m.id;
  }

  beforeAll(async () => {
    const product = await prisma.product.create({ data: { type: 'course', title: `${TAG}-p`, price: 0 } });
    productId = product.id;
    A = await mkMember(null);
    B = await mkMember(A);
    C = await mkMember(null);
  });

  afterAll(async () => {
    await prisma.affiliateCommission.deleteMany({ where: { buyerMemberId: B } });
    await prisma.product.delete({ where: { id: productId } });
    if (ids.length) await prisma.member.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  it('no override → permanent inviter A receives the commission (any product, no program)', async () => {
    const paymentId = randomUUID();
    const res = await svc.commitCommissionsForPayment({
      paymentId,
      productId,
      productPrice: 100_000,
      voucherAmount: 0,
      buyerMemberId: B,
      programId: null, // Option B: no program needed
    });
    expect(res.committed).toBe(1);
    const rows = await prisma.affiliateCommission.findMany({ where: { paymentId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.recipientId).toBe(A);
    expect(rows[0]?.amount).toBe(20_000); // PERFORMANCE tier 1 (20%)
    expect(rows[0]?.programId).toBeNull();
  });

  it('with link override C → C receives the commission, not A', async () => {
    const paymentId = randomUUID();
    const res = await svc.commitCommissionsForPayment({
      paymentId,
      productId,
      productPrice: 100_000,
      voucherAmount: 0,
      buyerMemberId: B,
      programId: null,
      overrideAffiliatorMemberId: C,
    });
    expect(res.committed).toBe(1);
    const rows = await prisma.affiliateCommission.findMany({ where: { paymentId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.recipientId).toBe(C);
    expect(rows[0]?.recipientId).not.toBe(A);
    expect(rows[0]?.amount).toBe(20_000);
  });
});
