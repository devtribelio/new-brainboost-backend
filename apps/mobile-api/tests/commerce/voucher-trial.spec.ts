/**
 * Free-trial voucher end-to-end: checkout → amount-0 bypass → time-boxed grant →
 * expiry → conversion to a paid enrollment.
 *
 * The rules being pinned down here are the ones that are invisible from the
 * schema: a trial grants access WITHOUT counting as a purchase, expiry is a
 * property of the row rather than of a cleanup job, and `expired_date` is only
 * ever honoured for trial rows (a retail/legacy row carrying a date must keep
 * working forever). Requires a real Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { registerCommerceListeners } from '@bb/domain/commerce/listeners/payment-success.listener';
import { hasActiveEnrollment } from '@bb/domain/commerce/enrollment';
import { CheckoutService } from '@bb/domain/commerce/checkout.service';
import { PaymentService } from '@bb/domain/commerce/payment.service';
import { ProductService } from '@/modules/product/product.service';

const TAG = `trial-${Date.now()}`;
const PAGE = { page: 1, perPage: 50, skip: 0, take: 50 };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The enrollment grant runs off an async listener — poll for it. */
async function waitForEnrollment(memberId: string, courseId: string, tries = 25) {
  for (let i = 0; i < tries; i++) {
    const row = await prisma.courseEnrollment.findFirst({ where: { memberId, courseId } });
    if (row) return row;
    await wait(120);
  }
  return null;
}

/**
 * The voucher redeem runs off its OWN listener, so waiting for the enrollment
 * proves nothing about it — the two land independently and the redeem can be
 * the slower one. Asserting the count directly made this spec fail whenever
 * suite timing shifted.
 */
async function waitForRedemption(voucherId: string, tries = 25) {
  for (let i = 0; i < tries; i++) {
    const count = await prisma.voucherRedemption.count({ where: { voucherId } });
    if (count > 0) return count;
    await wait(120);
  }
  return 0;
}

describe('free-trial voucher', () => {
  const checkout = new CheckoutService();
  const payment = new PaymentService();
  const productService = new ProductService();

  let memberId = '';
  let productId = '';
  let courseId = '';
  const trialCode = `${TAG}-CODE`;
  let trialVoucherId = '';

  beforeAll(async () => {
    registerCommerceListeners();

    const member = await prisma.member.create({
      data: { email: `${TAG}@t.local`, passwordHash: await bcrypt.hash('x', 4) },
    });
    memberId = member.id;

    const product = await prisma.product.create({
      data: {
        type: 'course',
        title: `${TAG}-product`,
        price: 300_000,
        isActive: true,
        status: 'active',
      },
    });
    productId = product.id;
    const course = await prisma.course.create({ data: { productId, durationMin: 60 } });
    courseId = course.id;

    const voucher = await prisma.voucher.create({
      data: { code: trialCode, type: 'TRIAL', value: 0, trialDays: 7, isActive: true },
    });
    trialVoucherId = voucher.id;
    await prisma.voucherProduct.create({ data: { voucherId: voucher.id, productId } });
  });

  afterAll(async () => {
    await prisma.voucherRedemption.deleteMany({ where: { voucherId: trialVoucherId } });
    await prisma.commercePayment.deleteMany({ where: { memberId } });
    await prisma.commerceTransaction.deleteMany({ where: { memberId } });
    await prisma.courseEnrollment.deleteMany({ where: { memberId } });
    await prisma.voucherProduct.deleteMany({ where: { voucherId: trialVoucherId } });
    await prisma.voucher.delete({ where: { id: trialVoucherId } });
    await prisma.course.delete({ where: { id: courseId } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.member.delete({ where: { id: memberId } });
    await prisma.$disconnect();
  });

  /** Run the two-step checkout with the trial code and settle it. */
  async function redeemTrial() {
    const tx = await checkout.start({ memberId, productId, voucherCode: trialCode });
    expect(tx.amount).toBe(0); // 100% off — settles without touching Xendit
    const result = await payment.create(memberId, { transactionId: tx.transactionId });
    expect(result.paymentStatus).toBe('SUCCESS');
    return tx;
  }

  it('grants a time-boxed enrollment marked with the voucher', async () => {
    await redeemTrial();
    const row = await waitForEnrollment(memberId, courseId);
    expect(row).not.toBeNull();
    expect(row!.viaVoucherId).toBe(trialVoucherId);
    expect(row!.expiredDate).toBeInstanceOf(Date);

    const days = (row!.expiredDate!.getTime() - Date.now()) / (24 * 3600 * 1000);
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);

    expect(await hasActiveEnrollment(memberId, courseId)).toBe(true);
    expect(await waitForRedemption(trialVoucherId)).toBe(1);
  });

  it('a trial course shows as owned and drops out of the not_purchased shelf', async () => {
    const purchased = await productService.list(PAGE, { memberId, ownership: 'purchased' });
    expect(purchased.rows.map((r) => r.id)).toContain(productId);

    // The member can already open it, so it does not belong on a "belum dibeli"
    // shelf — even though no money changed hands yet. It comes back on expiry.
    const catalog = await productService.list(PAGE, { memberId, ownership: 'not_purchased' });
    expect(catalog.rows.map((r) => r.id)).not.toContain(productId);
  });

  it('refuses a second checkout with the same trial code', async () => {
    await expect(checkout.start({ memberId, productId, voucherCode: trialCode })).rejects.toThrow();
  });

  it('access dies on its own once expired_date passes — no cleanup job', async () => {
    await prisma.courseEnrollment.updateMany({
      where: { memberId, courseId },
      data: { expiredDate: new Date(Date.now() - 1000) },
    });
    expect(await hasActiveEnrollment(memberId, courseId)).toBe(false);

    const purchased = await productService.list(PAGE, { memberId, ownership: 'purchased' });
    expect(purchased.rows.map((r) => r.id)).not.toContain(productId);

    // ...and returns to the catalog, so the member can still buy it.
    const catalog = await productService.list(PAGE, { memberId, ownership: 'not_purchased' });
    expect(catalog.rows.map((r) => r.id)).toContain(productId);
  });

  it('expired_date is ignored on a retail row (legacy lifetime purchases must not expire)', async () => {
    await prisma.courseEnrollment.updateMany({
      where: { memberId, courseId },
      data: { viaVoucherId: null }, // expired_date stays in the past
    });
    expect(await hasActiveEnrollment(memberId, courseId)).toBe(true);

    // restore the trial state for the conversion test below
    await prisma.courseEnrollment.updateMany({
      where: { memberId, courseId },
      data: { viaVoucherId: trialVoucherId, progress: 42 },
    });
  });

  it('buying the course converts the trial row: permanent access, progress reset', async () => {
    const tx = await checkout.start({ memberId, productId }); // no voucher — full price
    expect(tx.amount).toBe(300_000);

    // Settle it the way the webhook would, then let the listener convert the row.
    await prisma.commerceTransaction.update({
      where: { id: tx.transactionId },
      data: { status: 'PAID', paidAt: new Date() },
    });
    const { commerceEvents } = await import('@bb/common/events/commerce-events');
    commerceEvents.emit('commerce.payment.success', {
      paymentId: tx.transactionId, // no payment row needed for the enrollment effect
      transactionId: tx.transactionId,
      memberId,
      productId,
      amount: 300_000,
      voucherAmount: 0,
      voucherId: null,
    });

    for (let i = 0; i < 25; i++) {
      const row = await prisma.courseEnrollment.findFirst({ where: { memberId, courseId } });
      if (row?.viaVoucherId === null) {
        expect(row.expiredDate).toBeNull();
        expect(row.progress).toBe(0); // conversion restarts the course
        expect(await hasActiveEnrollment(memberId, courseId)).toBe(true);
        return;
      }
      await wait(120);
    }
    throw new Error('trial row was never converted to a paid enrollment');
  });
});
