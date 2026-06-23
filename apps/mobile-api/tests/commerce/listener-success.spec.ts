import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@bb/db';
import { commerceEvents } from '@bb/common/events/commerce-events';
import { registerCommerceListeners } from '@bb/domain/commerce/listeners/payment-success.listener';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';

function uid(): string {
  return `${Math.random().toString(36).slice(2, 12)}`;
}

async function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('commerce.payment.success listener', () => {
  let memberId = '';
  let inviterId = '';
  let productId = '';
  let courseId = '';
  let voucherId = '';
  let programId = '';

  beforeAll(async () => {
    registerCommerceListeners();

    const inviter = await prisma.member.create({
      data: {
        email: `inviter-${uid()}@test.local`,
        passwordHash: await bcrypt.hash('s', 4),
        affiliateBased: 'PERFORMANCE',
      },
    });
    inviterId = inviter.id;

    const m = await prisma.member.create({
      data: {
        email: `buyer-${uid()}@test.local`,
        passwordHash: await bcrypt.hash('s', 4),
        inviterId,
      },
    });
    memberId = m.id;

    const product = await prisma.product.create({
      data: { type: 'course', title: 'Listener Test', price: 500_000 },
    });
    productId = product.id;
    const course = await prisma.course.create({
      data: { productId: product.id, durationMin: 60 },
    });
    courseId = course.id;

    const program = await prisma.affiliateProgram.create({
      data: { code: `PROG-${uid()}`, name: 'Listener Program', productId, isActive: true },
    });
    programId = program.id;
    // ensure inviter is enrolled as MemberAffiliator for the program
    await prisma.memberAffiliator.create({
      data: { memberId: inviterId, programId, isActive: true },
    });

    const v = await prisma.voucher.create({
      data: {
        code: `VOUCH-${uid()}`,
        type: 'AMOUNT',
        value: 50_000,
        isActive: true,
        quota: 5,
      },
    });
    voucherId = v.id;
  });

  afterAll(async () => {
    await prisma.affiliateCommission.deleteMany({ where: { buyerMemberId: memberId } });
    await prisma.courseEnrollment.deleteMany({ where: { memberId } });
    await prisma.memberAffiliator.deleteMany({ where: { programId } });
    await prisma.affiliateProgram.delete({ where: { id: programId } });
    await prisma.voucher.delete({ where: { id: voucherId } });
    await prisma.course.delete({ where: { id: courseId } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.member.delete({ where: { id: memberId } });
    await prisma.member.delete({ where: { id: inviterId } });
    await prisma.$disconnect();
  });

  it('grants CourseEnrollment, commits affiliate commission, redeems voucher', async () => {
    const paymentId = randomUUID();
    const transactionId = randomUUID();
    commerceEvents.emit('commerce.payment.success', {
      paymentId,
      transactionId,
      memberId,
      productId,
      amount: 450_000,
      voucherAmount: 50_000,
      voucherId,
      affiliatorId: null,
      programId,
    });
    await wait(150);

    const enrollment = await prisma.courseEnrollment.findUnique({
      where: { memberId_courseId: { memberId, courseId } },
    });
    expect(enrollment).not.toBeNull();

    const commission = await prisma.affiliateCommission.findFirst({
      where: { buyerMemberId: memberId, paymentId },
    });
    expect(commission).not.toBeNull();
    expect(commission?.recipientId).toBe(inviterId);
    expect(commission?.amount).toBe(Math.floor((500_000 - 50_000) * 0.2));

    const voucherAfter = await prisma.voucher.findUnique({ where: { id: voucherId } });
    expect(voucherAfter?.used).toBe(1);
  });

  it('uses acceptedAmount (net) as commission base when present — IAP markup does not leak to affiliator', async () => {
    // Scenario: IAP price marked up to 429k to offset Apple's 30% cut so net
    // ≈ web price (300_300). Commission must be rate × NET (not rate × gross),
    // else markup leaks as bonus affiliator commission.
    const paymentId = randomUUID();
    const transactionId = randomUUID();
    commerceEvents.emit('commerce.payment.success', {
      paymentId,
      transactionId,
      memberId,
      productId,
      amount: 429_000, // gross — what customer paid via IAP
      acceptedAmount: 300_300, // net — what we settle from Apple
      voucherAmount: 0,
      voucherId: null,
      affiliatorId: null,
      programId,
    });
    await wait(150);

    const commission = await prisma.affiliateCommission.findFirst({
      where: { buyerMemberId: memberId, paymentId },
    });
    expect(commission).not.toBeNull();
    // PERFORMANCE T1 rate 20% applied to NET, not gross:
    //   gross basis would be 0.2 × 429_000 = 85_800 (current behavior — WRONG for IAP)
    //   net   basis      is 0.2 × 300_300 = 60_060 (correct — matches web 0.2 × 300_000)
    expect(commission?.amount).toBe(Math.floor(300_300 * 0.2));
    expect(commission?.amount).not.toBe(Math.floor(429_000 * 0.2));
  });

  it('idempotent: re-emit same paymentId does not duplicate side effects', async () => {
    const paymentId = randomUUID();
    const transactionId = randomUUID();
    const payload = {
      paymentId,
      transactionId,
      memberId,
      productId,
      amount: 450_000,
      voucherAmount: 50_000,
      voucherId: null, // do not redeem voucher again
      affiliatorId: null,
      programId,
    };

    commerceEvents.emit('commerce.payment.success', payload);
    await wait(150);
    commerceEvents.emit('commerce.payment.success', payload);
    await wait(150);

    const commissions = await prisma.affiliateCommission.findMany({
      where: { buyerMemberId: memberId, paymentId },
    });
    expect(commissions).toHaveLength(1);

    const enrollments = await prisma.courseEnrollment.findMany({
      where: { memberId, courseId },
    });
    expect(enrollments).toHaveLength(1);
  });

  it('no programId: still commissions the buyer inviter (Option B — program optional)', async () => {
    const paymentId = randomUUID();
    const transactionId = randomUUID();
    commerceEvents.emit('commerce.payment.success', {
      paymentId,
      transactionId,
      memberId,
      productId,
      amount: 500_000,
      voucherAmount: 0,
      voucherId: null,
      affiliatorId: null,
      programId: null,
    });
    await wait(150);

    // Option B: any product is affiliate-able; commission follows the permanent inviter
    // even without a program. Recipient = inviter, programId stays null.
    const commissions = await prisma.affiliateCommission.findMany({
      where: { buyerMemberId: memberId, paymentId },
    });
    expect(commissions).toHaveLength(1);
    expect(commissions[0]?.recipientId).toBe(inviterId);
    expect(commissions[0]?.programId).toBeNull();
    expect(commissions[0]?.amount).toBe(Math.floor(500_000 * 0.2)); // PERFORMANCE tier 1 (20%)
  });
});
