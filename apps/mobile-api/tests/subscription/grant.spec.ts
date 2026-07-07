/**
 * BE-04 — SubscriptionService.grant: no-payment activation (source='granted',
 * ledger kind='grant', transactionId NULL), months override, extend on same
 * plan, reject on different plan, and parity with paid subs (seats, renewal
 * by later repurchase). Real Postgres, no mocks.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@bb/db';
import { SubscriptionService } from '@bb/domain/subscription/subscription.service';
import { BadRequestException } from '@bb/common/exceptions';

const service = new SubscriptionService();
const uniq = randomUUID().slice(0, 8);
const DAY_MS = 24 * 60 * 60 * 1000;

let memberId: string;
let soloCode: string;
let duoCode: string;
let soloProductId: string;

async function makePlan(tag: string, seatCount: number) {
  const product = await prisma.product.create({
    data: {
      type: 'subscription',
      code: `TST-GRT-${tag}-${uniq}`,
      title: `Test grant ${tag}`,
      price: 999_000,
    },
  });
  await prisma.subscriptionPlan.create({
    data: {
      productId: product.id,
      code: `TSTG_${tag}_${uniq}`,
      tier: tag,
      periodMonths: 12,
      seatCount,
      affiliateRate: 40,
      renewalAffiliateRate: 20,
      sortOrder: 99,
    },
  });
  return { productId: product.id, code: `TSTG_${tag}_${uniq}` };
}

async function cleanup() {
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
  const m = await prisma.member.create({
    data: { email: `grant-${uniq}@test.local`, passwordHash: 'x', isActive: true },
  });
  memberId = m.id;
  ({ code: soloCode, productId: soloProductId } = await makePlan('SOLO', 2));
  ({ code: duoCode } = await makePlan('DUO', 3));
});

beforeEach(async () => {
  await prisma.memberSubscription.deleteMany({ where: { ownerId: memberId } });
});

afterAll(cleanup);

describe('SubscriptionService.grant', () => {
  it('rejects an unknown plan code', async () => {
    await expect(service.grant(memberId, 'NOPE_12M')).rejects.toThrow(BadRequestException);
  });

  it('creates a sub identical to a paid one: seats provisioned, owner on seat 1, ledger kind=grant', async () => {
    const res = await service.grant(memberId, soloCode);
    expect(res.outcome).toBe('created');
    const sub = res.subscription;
    expect(sub.source).toBe('granted');
    expect(sub.latestTransactionId).toBeNull();

    const expected = new Date();
    expected.setMonth(expected.getMonth() + 12);
    expect(Math.abs(sub.expiresAt.getTime() - expected.getTime())).toBeLessThan(60_000);
    expect(sub.graceUntil!.getTime() - sub.expiresAt.getTime()).toBe(7 * DAY_MS);

    const seats = await prisma.subscriptionSeat.findMany({
      where: { subscriptionId: sub.id },
      orderBy: { seatNo: 'asc' },
    });
    expect(seats).toHaveLength(2);
    expect(seats[0].memberId).toBe(memberId);

    const ledger = await prisma.subscriptionActivation.findMany({
      where: { subscriptionId: sub.id },
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ kind: 'grant', source: 'granted', transactionId: null });
  });

  it('honors the months override', async () => {
    const res = await service.grant(memberId, soloCode, 3);
    const expected = new Date();
    expected.setMonth(expected.getMonth() + 3);
    expect(Math.abs(res.subscription.expiresAt.getTime() - expected.getTime())).toBeLessThan(
      60_000,
    );
  });

  it('extends when the member already has the same plan ACTIVE', async () => {
    const first = await service.grant(memberId, soloCode);
    const res = await service.grant(memberId, soloCode, 6);
    expect(res.outcome).toBe('extended');

    const expected = new Date(first.subscription.expiresAt);
    expected.setMonth(expected.getMonth() + 6);
    expect(res.subscription.expiresAt.getTime()).toBe(expected.getTime());

    const ledger = await prisma.subscriptionActivation.findMany({
      where: { subscriptionId: first.subscription.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(ledger.map((l) => l.kind)).toEqual(['grant', 'grant']);
  });

  it('rejects a grant for a different plan while another is ACTIVE', async () => {
    await service.grant(memberId, soloCode);
    await expect(service.grant(memberId, duoCode)).rejects.toThrow(
      /different plan — grant rejected/,
    );
  });

  it('a granted sub renews normally via a later paid repurchase', async () => {
    const granted = await service.grant(memberId, soloCode);
    const res = await service.activateFromPayment({
      ownerId: memberId,
      productId: soloProductId,
      transactionId: randomUUID(),
      source: 'xendit',
    });
    expect(res.outcome).toBe('renewal');
    expect(res.subscription!.id).toBe(granted.subscription.id);
    expect(res.subscription!.source).toBe('xendit'); // latest activation source
    const expected = new Date(granted.subscription.expiresAt);
    expected.setMonth(expected.getMonth() + 12);
    expect(res.subscription!.expiresAt.getTime()).toBe(expected.getTime());
  });
});
