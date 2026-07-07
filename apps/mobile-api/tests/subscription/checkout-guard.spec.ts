/**
 * BE-14 — checkout guard for subscription products: different-plan purchase
 * while ACTIVE → 400; same plan = renewal-by-repurchase → allowed; seated on
 * someone else's ACTIVE sub → 400 (zombie seats don't block); retail checkout
 * untouched. Real Postgres, no mocks.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@bb/db';
import { CheckoutService } from '@bb/domain/commerce/checkout.service';
import { SubscriptionService } from '@bb/domain/subscription/subscription.service';
import { SeatService } from '@bb/domain/subscription/seat.service';

const checkout = new CheckoutService();
const subscriptionService = new SubscriptionService();
const seatService = new SeatService();
const uniq = randomUUID().slice(0, 8);

let ownerId: string;
let seatMemberId: string;
let freshId: string;
let soloProductId: string;
let duoProductId: string;
let courseProductId: string;

async function makeMember(tag: string): Promise<string> {
  const m = await prisma.member.create({
    data: { email: `cog-${tag}-${uniq}@test.local`, passwordHash: 'x', isActive: true },
  });
  return m.id;
}

async function makePlanProduct(tag: string, seatCount: number): Promise<string> {
  const p = await prisma.product.create({
    data: {
      type: 'subscription',
      code: `TSTCG-${tag}-${uniq}`,
      title: `CG ${tag}`,
      price: 999_000,
      isActive: true,
      status: 'active',
    },
  });
  await prisma.subscriptionPlan.create({
    data: {
      productId: p.id,
      code: `TSTCG_${tag}_${uniq}`,
      tier: tag,
      periodMonths: 12,
      seatCount,
      affiliateRate: 40,
      renewalAffiliateRate: 20,
      sortOrder: 99,
    },
  });
  return p.id;
}

async function cleanup() {
  const memberIds = (
    await prisma.member.findMany({ where: { email: { contains: uniq } }, select: { id: true } })
  ).map((m) => m.id);
  await prisma.commerceTransaction.deleteMany({ where: { memberId: { in: memberIds } } });
  const subs = await prisma.memberSubscription.findMany({
    where: { ownerId: { in: memberIds } },
    select: { id: true },
  });
  await prisma.memberSubscription.deleteMany({ where: { id: { in: subs.map((s) => s.id) } } });
  await prisma.subscriptionPlan.deleteMany({ where: { code: { contains: uniq } } });
  await prisma.product.deleteMany({ where: { code: { contains: uniq } } });
  await prisma.member.deleteMany({ where: { id: { in: memberIds } } });
}

beforeAll(async () => {
  await cleanup();
  ownerId = await makeMember('owner');
  seatMemberId = await makeMember('seatm');
  freshId = await makeMember('fresh');
  soloProductId = await makePlanProduct('SOLO', 2);
  duoProductId = await makePlanProduct('DUO', 3);
  const course = await prisma.product.create({
    data: {
      type: 'course',
      code: `TSTCG-CRS-${uniq}`,
      title: 'CG course',
      price: 100_000,
      isActive: true,
      status: 'active',
      course: { create: {} },
    },
  });
  courseProductId = course.id;
});

beforeEach(async () => {
  const memberIds = [ownerId, seatMemberId, freshId];
  await prisma.commerceTransaction.deleteMany({ where: { memberId: { in: memberIds } } });
  const subs = await prisma.memberSubscription.findMany({
    where: { ownerId: { in: memberIds } },
    select: { id: true },
  });
  await prisma.memberSubscription.deleteMany({ where: { id: { in: subs.map((s) => s.id) } } });
});

afterAll(cleanup);

async function activateSolo(owner = ownerId) {
  return (
    await subscriptionService.activateFromPayment({
      ownerId: owner,
      productId: soloProductId,
      transactionId: randomUUID(),
      source: 'xendit',
    })
  ).subscription!;
}

describe('checkout guard for subscription products (BE-14)', () => {
  it('ACTIVE SOLO buying DUO → 400 (tier switch is Phase 2)', async () => {
    await activateSolo();
    await expect(
      checkout.start({ memberId: ownerId, productId: duoProductId }),
    ).rejects.toThrow('paket lain');
  });

  it('ACTIVE SOLO re-buying SOLO → allowed (web renewal-by-repurchase)', async () => {
    await activateSolo();
    const res = await checkout.start({ memberId: ownerId, productId: soloProductId });
    expect(res.transactionId).toBeTruthy();
    const tx = await prisma.commerceTransaction.findUniqueOrThrow({
      where: { id: res.transactionId },
    });
    expect(tx.status).toBe('PENDING');
  });

  it('seated on someone else’s ACTIVE sub → 400 for any plan purchase', async () => {
    await activateSolo();
    const { inviteCode } = await seatService.generateInvite(ownerId);
    await seatService.claimSeat(seatMemberId, inviteCode);

    await expect(
      checkout.start({ memberId: seatMemberId, productId: soloProductId }),
    ).rejects.toThrow('keluar dulu');
    await expect(
      checkout.start({ memberId: seatMemberId, productId: duoProductId }),
    ).rejects.toThrow('keluar dulu');
  });

  it('a zombie seat (dead sub) does NOT block buying an own plan', async () => {
    const sub = await activateSolo();
    const { inviteCode } = await seatService.generateInvite(ownerId);
    await seatService.claimSeat(seatMemberId, inviteCode);
    await prisma.memberSubscription.update({
      where: { id: sub.id },
      data: { status: 'EXPIRED' },
    });

    const res = await checkout.start({ memberId: seatMemberId, productId: soloProductId });
    expect(res.transactionId).toBeTruthy();
  });

  it('non-subscriber buying a plan → allowed; subscriber buying retail → allowed', async () => {
    const fresh = await checkout.start({ memberId: freshId, productId: duoProductId });
    expect(fresh.transactionId).toBeTruthy();

    await activateSolo();
    const retail = await checkout.start({ memberId: ownerId, productId: courseProductId });
    expect(retail.transactionId).toBeTruthy();
  });
});
