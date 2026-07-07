/**
 * BE-09 — flat subscription commission: exactly ONE level-1 row (no GROWTH
 * upline, no PERFORMANCE tiering), rate from the plan (40 first sale /
 * renewalAffiliateRate on renewals), renewal detected via provider flag OR
 * activation ledger (order-independent, grants excluded), voucher reduces the
 * base, redelivery no-op, buyer self-commission guarded. Real Postgres.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@bb/db';
import { AffiliatorService } from '@bb/domain/affiliate/affiliator.service';
import { SubscriptionService } from '@bb/domain/subscription/subscription.service';

const affiliatorService = new AffiliatorService();
const subscriptionService = new SubscriptionService();
const uniq = randomUUID().slice(0, 8);

const PRICE = 999_000;

let grandInviterId: string; // GROWTH upline of the inviter — must earn NOTHING
let inviterId: string;
let buyerId: string;
let productId: string;
let planCode: string;

async function makeMember(tag: string, data: Record<string, unknown> = {}): Promise<string> {
  const m = await prisma.member.create({
    data: { email: `flatc-${tag}-${uniq}@test.local`, passwordHash: 'x', isActive: true, ...data },
  });
  return m.id;
}

function commit(over: Partial<Parameters<AffiliatorService['commitCommissionsForPayment']>[0]> = {}) {
  return affiliatorService.commitCommissionsForPayment({
    paymentId: randomUUID(),
    productId,
    productPrice: PRICE,
    voucherAmount: 0,
    buyerMemberId: buyerId,
    transactionId: randomUUID(),
    ...over,
  });
}

async function cleanup() {
  await prisma.affiliateCommission.deleteMany({
    where: { recipient: { email: { contains: uniq } } },
  });
  const subs = await prisma.memberSubscription.findMany({
    where: { plan: { code: { contains: uniq } } },
    select: { id: true },
  });
  await prisma.memberSubscription.deleteMany({ where: { id: { in: subs.map((s) => s.id) } } });
  await prisma.subscriptionPlan.deleteMany({ where: { code: { contains: uniq } } });
  await prisma.product.deleteMany({ where: { code: { contains: uniq } } });
  await prisma.member.deleteMany({ where: { email: { contains: uniq } } });
}

beforeAll(async () => {
  await cleanup();
  grandInviterId = await makeMember('grand', { affiliateBased: 'GROWTH' });
  inviterId = await makeMember('inviter', { affiliateBased: 'GROWTH', inviterId: grandInviterId });
  buyerId = await makeMember('buyer', { inviterId });

  const product = await prisma.product.create({
    data: { type: 'subscription', code: `TST-FLAT-${uniq}`, title: 'Flat sub', price: PRICE },
  });
  productId = product.id;
  planCode = `TSTF_SOLO_${uniq}`;
  await prisma.subscriptionPlan.create({
    data: {
      productId,
      code: planCode,
      tier: 'SOLO',
      periodMonths: 12,
      seatCount: 1,
      affiliateRate: 40,
      renewalAffiliateRate: 20,
      sortOrder: 99,
    },
  });
});

beforeEach(async () => {
  await prisma.affiliateCommission.deleteMany({
    where: { recipient: { email: { contains: uniq } } },
  });
  const subs = await prisma.memberSubscription.findMany({
    where: { ownerId: buyerId },
    select: { id: true },
  });
  await prisma.memberSubscription.deleteMany({ where: { id: { in: subs.map((s) => s.id) } } });
});

afterAll(cleanup);

async function rows() {
  return prisma.affiliateCommission.findMany({
    where: { productId },
    orderBy: { createdAt: 'asc' },
  });
}

describe('flat subscription commission (BE-09)', () => {
  it('first sale: exactly ONE level-1 row at 40% — the GROWTH upline earns nothing', async () => {
    const res = await commit();
    expect(res.committed).toBe(1);

    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      recipientId: inviterId,
      level: 1,
      schemaType: 'FLAT',
      commissionRate: 40,
      amount: 399_600, // floor(999000 * 40 / 100)
      status: 'PENDING',
    });
    // grand inviter (L2 in the retail scheme) got nothing
    expect(all.some((r) => r.recipientId === grandInviterId)).toBe(false);
  });

  it('web renewal (no flag): detected via activation ledger → renewal rate', async () => {
    // First paid activation lands in the ledger…
    const firstTx = randomUUID();
    await subscriptionService.activateFromPayment({
      ownerId: buyerId,
      productId,
      transactionId: firstTx,
      source: 'xendit',
    });
    await commit({ transactionId: firstTx }); // first-sale commission (40)

    // …then the renewal purchase: a DIFFERENT transactionId, no isRenewal flag.
    const renewTx = randomUUID();
    await subscriptionService.activateFromPayment({
      ownerId: buyerId,
      productId,
      transactionId: renewTx,
      source: 'xendit',
    });
    await commit({ transactionId: renewTx });

    const all = await rows();
    expect(all.map((r) => r.commissionRate)).toEqual([40, 20]);
    expect(all[1].amount).toBe(199_800); // floor(999000 * 20 / 100)
  });

  it('order-independent: commission listener running BEFORE activation still pays first-sale rate', async () => {
    // No activation ledger rows at all yet (activation listener hasn't run) —
    // the commission for THIS tx must not see itself as a prior sale.
    const res = await commit();
    expect(res.committed).toBe(1);
    expect((await rows())[0].commissionRate).toBe(40);
  });

  it('provider flag isRenewal=true forces the renewal rate (RC path)', async () => {
    await commit({ isRenewal: true });
    expect((await rows())[0].commissionRate).toBe(20);
  });

  it('a grant does NOT count as a prior sale — first payment after grant pays 40%', async () => {
    await subscriptionService.grant(buyerId, planCode);
    const txId = randomUUID();
    await subscriptionService.activateFromPayment({
      ownerId: buyerId,
      productId,
      transactionId: txId,
      source: 'xendit',
    });
    await commit({ transactionId: txId });
    expect((await rows())[0].commissionRate).toBe(40);
  });

  it('voucher reduces the commission base', async () => {
    await commit({ voucherAmount: 100_000 });
    expect((await rows())[0].amount).toBe(359_600); // floor((999000-100000) * 40 / 100)
  });

  it('redelivery (same paymentId) commits nothing new', async () => {
    const paymentId = randomUUID();
    const first = await commit({ paymentId });
    const replay = await commit({ paymentId });
    expect(first.committed).toBe(1);
    expect(replay.committed).toBe(0);
    expect(await rows()).toHaveLength(1);
  });

  it('buyer self-commission is guarded (link override pointing at the buyer)', async () => {
    const res = await commit({ overrideAffiliatorMemberId: buyerId });
    expect(res.committed).toBe(0);
    expect(await rows()).toHaveLength(0);
  });

  it('no inviter and no override → skip', async () => {
    const orphanId = await makeMember(`orphan-${randomUUID().slice(0, 4)}`);
    const res = await commit({ buyerMemberId: orphanId });
    expect(res.committed).toBe(0);
  });
});
