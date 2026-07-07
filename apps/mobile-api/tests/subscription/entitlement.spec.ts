/**
 * BE-06 — EntitlementService + lazy enrollment:
 * retail rows valid by EXISTENCE (legacy expired_date ignored — the sacred
 * rule), lazy rows valid by date; subscriber access lazily creates/refreshes
 * a marked enrollment; lapsed sub → 403; retail purchase over a lazy row
 * upgrades it to lifetime (marker cleared). Real Postgres, no mocks.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@bb/db';
import { commerceEvents } from '@bb/common/events/commerce-events';
import { SubscriptionService } from '@bb/domain/subscription/subscription.service';
import { SeatService } from '@bb/domain/subscription/seat.service';
import { EntitlementService } from '@bb/domain/subscription/entitlement.service';
import { registerCommerceListeners } from '@bb/domain/commerce/listeners/payment-success.listener';
import { ForbiddenException } from '@bb/common/exceptions';

const subscriptionService = new SubscriptionService();
const seatService = new SeatService();
const entitlement = new EntitlementService();
const uniq = randomUUID().slice(0, 8);
const DAY_MS = 24 * 3600 * 1000;

let ownerId: string;
let seatMemberId: string;
let outsiderId: string;
let subProductId: string;
let courseId: string;
let courseProductId: string;

async function waitFor<T>(fn: () => Promise<T | null | undefined>, ms = 3000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function makeMember(tag: string): Promise<string> {
  const m = await prisma.member.create({
    data: { email: `ent-${tag}-${uniq}@test.local`, passwordHash: 'x', isActive: true },
  });
  return m.id;
}

async function cleanup() {
  const subs = await prisma.memberSubscription.findMany({
    where: { plan: { code: { contains: uniq } } },
    select: { id: true },
  });
  await prisma.courseEnrollment.deleteMany({
    where: {
      OR: [
        { viaSubscriptionId: { in: subs.map((s) => s.id) } },
        { member: { email: { contains: uniq } } },
      ],
    },
  });
  await prisma.memberSubscription.deleteMany({ where: { id: { in: subs.map((s) => s.id) } } });
  await prisma.subscriptionPlan.deleteMany({ where: { code: { contains: uniq } } });
  await prisma.product.deleteMany({ where: { code: { contains: uniq } } });
  await prisma.member.deleteMany({ where: { email: { contains: uniq } } });
}

beforeAll(async () => {
  await cleanup();
  registerCommerceListeners();
  ownerId = await makeMember('owner');
  seatMemberId = await makeMember('seatm');
  outsiderId = await makeMember('out');

  const subProduct = await prisma.product.create({
    data: { type: 'subscription', code: `TST-ENT-SUB-${uniq}`, title: 'Ent sub', price: 1 },
  });
  subProductId = subProduct.id;
  await prisma.subscriptionPlan.create({
    data: {
      productId: subProductId,
      code: `TSTE_DUO_${uniq}`,
      tier: 'DUO',
      periodMonths: 12,
      seatCount: 2,
      affiliateRate: 40,
      renewalAffiliateRate: 20,
      sortOrder: 99,
    },
  });

  const courseProduct = await prisma.product.create({
    data: { type: 'course', code: `TST-ENT-CRS-${uniq}`, title: 'Ent course', price: 100 },
  });
  courseProductId = courseProduct.id;
  const course = await prisma.course.create({ data: { productId: courseProduct.id } });
  courseId = course.id;
});

beforeEach(async () => {
  await prisma.courseEnrollment.deleteMany({ where: { member: { email: { contains: uniq } } } });
  await prisma.memberSubscription.deleteMany({ where: { ownerId } });
});

afterAll(cleanup);

async function activateSub() {
  const res = await subscriptionService.activateFromPayment({
    ownerId,
    productId: subProductId,
    transactionId: randomUUID(),
    source: 'xendit',
  });
  return res.subscription!;
}

describe('EntitlementService', () => {
  it('retail row with a PAST expired_date (legacy migration) still grants access', async () => {
    await prisma.courseEnrollment.create({
      data: {
        memberId: outsiderId,
        courseId,
        expiredDate: new Date('2020-01-01'), // legacy-filled, must be ignored
      },
    });
    await expect(entitlement.assertCourseAccess(outsiderId, courseId)).resolves.toBeUndefined();
  });

  it('non-subscriber without enrollment → 403; no row is created', async () => {
    await expect(entitlement.assertCourseAccess(outsiderId, courseId)).rejects.toThrow(
      ForbiddenException,
    );
    expect(
      await prisma.courseEnrollment.count({ where: { memberId: outsiderId, courseId } }),
    ).toBe(0);
  });

  it('subscriber access lazily creates a marked enrollment mirroring sub expiry', async () => {
    const sub = await activateSub();
    await entitlement.assertCourseAccess(ownerId, courseId);

    const row = await prisma.courseEnrollment.findUniqueOrThrow({
      where: { memberId_courseId: { memberId: ownerId, courseId } },
    });
    expect(row.viaSubscriptionId).toBe(sub.id);
    expect(row.expiredDate!.getTime()).toBe(sub.expiresAt.getTime());

    // Second access: no duplicate, row still the same
    await entitlement.assertCourseAccess(ownerId, courseId);
    expect(await prisma.courseEnrollment.count({ where: { memberId: ownerId, courseId } })).toBe(1);
  });

  it('seat member (not owner) is entitled; after leaving they are not', async () => {
    await activateSub();
    const { inviteCode } = await seatService.generateInvite(ownerId);
    await seatService.claimSeat(seatMemberId, inviteCode);

    expect(await entitlement.hasActiveSubscription(seatMemberId)).toBe(true);
    await expect(entitlement.assertCourseAccess(seatMemberId, courseId)).resolves.toBeUndefined();

    await seatService.leaveSeat(seatMemberId);
    expect(await entitlement.hasActiveSubscription(seatMemberId)).toBe(false);
    // Their lazy row was zeroed by leaveSeat → gate now rejects.
    await expect(entitlement.assertCourseAccess(seatMemberId, courseId)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('lapsed sub (past grace) → 403 even with the lazy row still present', async () => {
    const sub = await activateSub();
    await entitlement.assertCourseAccess(ownerId, courseId);
    await prisma.memberSubscription.update({
      where: { id: sub.id },
      data: {
        expiresAt: new Date(Date.now() - 10 * DAY_MS),
        graceUntil: new Date(Date.now() - 3 * DAY_MS),
      },
    });
    // Lazy row's expiredDate is in the future (was set from original expiry),
    // but wait — renewal bumped nothing; simulate the honest state: the row
    // mirrors the sub expiry, which is now past.
    await prisma.courseEnrollment.updateMany({
      where: { memberId: ownerId, courseId },
      data: { expiredDate: new Date(Date.now() - 10 * DAY_MS) },
    });
    await expect(entitlement.assertCourseAccess(ownerId, courseId)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('a stale lazy row from an old sub refreshes onto the member’s new active sub', async () => {
    const oldSub = await activateSub();
    await entitlement.assertCourseAccess(ownerId, courseId);

    // Old sub dies past grace; a new one is bought (new sub row).
    await prisma.memberSubscription.update({
      where: { id: oldSub.id },
      data: {
        status: 'EXPIRED',
        expiresAt: new Date(Date.now() - 10 * DAY_MS),
        graceUntil: new Date(Date.now() - 3 * DAY_MS),
      },
    });
    await prisma.courseEnrollment.updateMany({
      where: { memberId: ownerId, courseId },
      data: { expiredDate: new Date(Date.now() - 10 * DAY_MS) },
    });
    const newSub = await activateSub();

    await entitlement.assertCourseAccess(ownerId, courseId);
    const row = await prisma.courseEnrollment.findUniqueOrThrow({
      where: { memberId_courseId: { memberId: ownerId, courseId } },
    });
    expect(row.viaSubscriptionId).toBe(newSub.id);
    expect(row.expiredDate!.getTime()).toBe(newSub.expiresAt.getTime());
  });

  it('retail purchase over a lazy row clears the marker (lifetime upgrade)', async () => {
    const sub = await activateSub();
    await entitlement.assertCourseAccess(ownerId, courseId);

    commerceEvents.emit('commerce.payment.success', {
      paymentId: randomUUID(),
      transactionId: randomUUID(),
      memberId: ownerId,
      productId: courseProductId,
      amount: 100,
      voucherAmount: 0,
      affiliateEligible: false,
    });

    const upgraded = await waitFor(async () => {
      const row = await prisma.courseEnrollment.findUnique({
        where: { memberId_courseId: { memberId: ownerId, courseId } },
      });
      return row && row.viaSubscriptionId === null ? row : null;
    });
    expect(upgraded.expiredDate).toBeNull();

    // Sub dies → access survives (row is retail now).
    await prisma.memberSubscription.update({
      where: { id: sub.id },
      data: {
        status: 'EXPIRED',
        expiresAt: new Date(Date.now() - 10 * DAY_MS),
        graceUntil: new Date(Date.now() - 3 * DAY_MS),
      },
    });
    await expect(entitlement.assertCourseAccess(ownerId, courseId)).resolves.toBeUndefined();
  });
});
