/**
 * BE-05 — SeatService: invite rotation (old code dies), single-use claim with
 * exactly one winner under concurrency, one-seat-per-member enforcement,
 * remove/leave freeing the slot AND cutting the leaver's lazy-enrollment
 * access immediately (retail rows untouched). Real Postgres, no mocks.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@bb/db';
import { SubscriptionService } from '@bb/domain/subscription/subscription.service';
import { SeatService } from '@bb/domain/subscription/seat.service';

const subscriptionService = new SubscriptionService();
const seatService = new SeatService();
const uniq = randomUUID().slice(0, 8);

let ownerId: string;
let memberA: string;
let memberB: string;
let productId: string;
let courseId: string;

async function makeMember(tag: string): Promise<string> {
  const m = await prisma.member.create({
    data: { email: `seat-${tag}-${uniq}@test.local`, passwordHash: 'x', isActive: true },
  });
  return m.id;
}

async function cleanup() {
  const subs = await prisma.memberSubscription.findMany({
    where: { plan: { code: { contains: uniq } } },
    select: { id: true },
  });
  const subIds = subs.map((s) => s.id);
  await prisma.courseEnrollment.deleteMany({
    where: { OR: [{ viaSubscriptionId: { in: subIds } }, { member: { email: { contains: uniq } } }] },
  });
  await prisma.memberSubscription.deleteMany({ where: { id: { in: subIds } } });
  await prisma.subscriptionPlan.deleteMany({ where: { code: { contains: uniq } } });
  await prisma.product.deleteMany({ where: { code: { contains: uniq } } });
  await prisma.member.deleteMany({ where: { email: { contains: uniq } } });
}

beforeAll(async () => {
  await cleanup();
  ownerId = await makeMember('owner');
  memberA = await makeMember('a');
  memberB = await makeMember('b');

  const product = await prisma.product.create({
    data: { type: 'subscription', code: `TST-SEAT-${uniq}`, title: 'Seat test', price: 1 },
  });
  productId = product.id;
  await prisma.subscriptionPlan.create({
    data: {
      productId,
      code: `TSTS_FAM_${uniq}`,
      tier: 'FAMILY',
      periodMonths: 12,
      seatCount: 3,
      affiliateRate: 40,
      renewalAffiliateRate: 20,
      sortOrder: 99,
    },
  });

  const courseProduct = await prisma.product.create({
    data: { type: 'course', code: `TST-SEAT-CRS-${uniq}`, title: 'Seat course', price: 1 },
  });
  const course = await prisma.course.create({ data: { productId: courseProduct.id } });
  courseId = course.id;
});

let subId: string;

beforeEach(async () => {
  await prisma.courseEnrollment.deleteMany({ where: { member: { email: { contains: uniq } } } });
  await prisma.memberSubscription.deleteMany({ where: { ownerId } });
  const res = await subscriptionService.activateFromPayment({
    ownerId,
    productId,
    transactionId: randomUUID(),
    source: 'xendit',
  });
  subId = res.subscription!.id;
});

afterAll(cleanup);

describe('SeatService', () => {
  it('generateInvite targets the first empty seat and rotation kills the old code', async () => {
    const first = await seatService.generateInvite(ownerId);
    expect(first.seatNo).toBe(2);
    const second = await seatService.generateInvite(ownerId);
    expect(second.seatNo).toBe(2); // same slot, new code
    expect(second.inviteCode).not.toBe(first.inviteCode);

    await expect(seatService.claimSeat(memberA, first.inviteCode)).rejects.toThrow(
      'Kode undangan tidak valid',
    );
    await expect(seatService.claimSeat(memberA, second.inviteCode)).resolves.toMatchObject({
      memberId: memberA,
      seatNo: 2,
      inviteCode: null, // single-use: consumed in the same statement
    });
  });

  it('exactly one winner when two members race for the same code', async () => {
    const { inviteCode } = await seatService.generateInvite(ownerId);
    const results = await Promise.allSettled([
      seatService.claimSeat(memberA, inviteCode),
      seatService.claimSeat(memberB, inviteCode),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    expect(won).toHaveLength(1);

    const claimed = await prisma.subscriptionSeat.findMany({
      where: { subscriptionId: subId, memberId: { not: null } },
    });
    expect(claimed).toHaveLength(2); // owner + exactly one winner
  });

  it('a member holding a seat cannot claim another (one seat per member, DB-enforced)', async () => {
    const inv1 = await seatService.generateInvite(ownerId);
    await seatService.claimSeat(memberA, inv1.inviteCode);
    const inv2 = await seatService.generateInvite(ownerId);
    expect(inv2.seatNo).toBe(3);
    await expect(seatService.claimSeat(memberA, inv2.inviteCode)).rejects.toThrow(
      'sudah tergabung di subscription lain',
    );
  });

  it('owner cannot claim their own invite; lapsed sub cannot be claimed', async () => {
    const { inviteCode } = await seatService.generateInvite(ownerId);
    await expect(seatService.claimSeat(ownerId, inviteCode)).rejects.toThrow('pemilik subscription');

    await prisma.memberSubscription.update({
      where: { id: subId },
      data: { expiresAt: new Date(Date.now() - 1000), graceUntil: new Date(Date.now() - 1000) },
    });
    await expect(seatService.claimSeat(memberA, inviteCode)).rejects.toThrow(
      'Subscription tidak aktif',
    );
  });

  it('removeSeat frees the slot and kills ONLY the lazy enrollment of the removed member', async () => {
    const { inviteCode } = await seatService.generateInvite(ownerId);
    const seat = await seatService.claimSeat(memberA, inviteCode);

    const future = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    await prisma.courseEnrollment.create({
      data: { memberId: memberA, courseId, viaSubscriptionId: subId, expiredDate: future },
    });
    const retailExpiry = new Date('2030-01-01');
    await prisma.courseEnrollment.create({
      data: { memberId: memberB, courseId, expiredDate: retailExpiry }, // retail row
    });

    await seatService.removeSeat(ownerId, seat.id);

    const freed = await prisma.subscriptionSeat.findUniqueOrThrow({ where: { id: seat.id } });
    expect(freed).toMatchObject({ memberId: null, claimedAt: null, inviteCode: null });

    const lazy = await prisma.courseEnrollment.findUniqueOrThrow({
      where: { memberId_courseId: { memberId: memberA, courseId } },
    });
    expect(lazy.expiredDate!.getTime()).toBeLessThanOrEqual(Date.now()); // access cut now

    const retail = await prisma.courseEnrollment.findUniqueOrThrow({
      where: { memberId_courseId: { memberId: memberB, courseId } },
    });
    expect(retail.expiredDate!.getTime()).toBe(retailExpiry.getTime()); // untouched
  });

  it('removeSeat guards: not-owner, seat 1, empty seat', async () => {
    const seats = await prisma.subscriptionSeat.findMany({
      where: { subscriptionId: subId },
      orderBy: { seatNo: 'asc' },
    });
    await expect(seatService.removeSeat(memberA, seats[0].id)).rejects.toThrow(
      'Bukan subscription milikmu',
    );
    await expect(seatService.removeSeat(ownerId, seats[0].id)).rejects.toThrow(
      'Seat owner tidak bisa dihapus',
    );
    await expect(seatService.removeSeat(ownerId, seats[1].id)).rejects.toThrow('Seat ini kosong');
  });

  it('leaveSeat frees the slot + kills access; owner cannot leave', async () => {
    const { inviteCode } = await seatService.generateInvite(ownerId);
    const seat = await seatService.claimSeat(memberA, inviteCode);
    await prisma.courseEnrollment.create({
      data: {
        memberId: memberA,
        courseId,
        viaSubscriptionId: subId,
        expiredDate: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      },
    });

    await seatService.leaveSeat(memberA);
    const freed = await prisma.subscriptionSeat.findUniqueOrThrow({ where: { id: seat.id } });
    expect(freed.memberId).toBeNull();
    const lazy = await prisma.courseEnrollment.findUniqueOrThrow({
      where: { memberId_courseId: { memberId: memberA, courseId } },
    });
    expect(lazy.expiredDate!.getTime()).toBeLessThanOrEqual(Date.now());

    await expect(seatService.leaveSeat(ownerId)).rejects.toThrow('Owner tidak bisa keluar');
    await expect(seatService.leaveSeat(memberA)).rejects.toThrow('tidak menempati seat');
  });

  it('a freed slot can be re-invited and claimed by someone else', async () => {
    const inv1 = await seatService.generateInvite(ownerId);
    const seat = await seatService.claimSeat(memberA, inv1.inviteCode);
    await seatService.removeSeat(ownerId, seat.id);

    const inv2 = await seatService.generateInvite(ownerId);
    expect(inv2.seatNo).toBe(2); // same slot recycled
    const claimed = await seatService.claimSeat(memberB, inv2.inviteCode);
    expect(claimed.memberId).toBe(memberB);
  });
});
