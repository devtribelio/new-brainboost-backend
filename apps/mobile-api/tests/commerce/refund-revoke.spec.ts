/**
 * Refund revokes access, re-purchase restores it.
 *
 * The refund path soft-cancels the enrollment instead of deleting it, so every
 * access check has to read `is_canceled` rather than mere row existence — that
 * asymmetry is what these tests pin down. Requires a real Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { registerCommerceListeners } from '@bb/domain/commerce/listeners/payment-success.listener';
import { hasActiveEnrollment } from '@bb/domain/commerce/enrollment';
import { CheckoutService } from '@bb/domain/commerce/checkout.service';
import { purchaseIngestService } from '@/modules/ingest/purchase-ingest.service';
import { credentialService } from '@/modules/ingest/credential.service';
import { ProductService } from '@/modules/product/product.service';
import { MediaService } from '@/modules/media/media.service';

const TAG = `refund-${Date.now()}`;
const PAGE = { page: 1, perPage: 50, skip: 0, take: 50 };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The enrollment grant runs off an async listener — poll for it. */
async function waitForActiveEnrollment(memberId: string, courseId: string, tries = 25) {
  for (let i = 0; i < tries; i++) {
    if (await hasActiveEnrollment(memberId, courseId)) return true;
    await wait(120);
  }
  return false;
}

describe('refund → revoke → re-purchase', () => {
  const productService = new ProductService();
  const mediaService = new MediaService();
  const checkoutService = new CheckoutService();

  let buyerId = '';
  let productId = '';
  let courseId = '';
  let credName = '';
  let credKey = '';

  beforeAll(async () => {
    registerCommerceListeners();

    const buyer = await prisma.member.create({
      data: { email: `${TAG}-buy@t.local`, passwordHash: await bcrypt.hash('x', 4) },
    });
    buyerId = buyer.id;

    const product = await prisma.product.create({
      data: {
        type: 'course',
        title: `${TAG}-product`,
        price: 100_000,
        isActive: true,
        status: 'active',
        iosProductId: `${TAG}-sku`,
      },
    });
    productId = product.id;
    const course = await prisma.course.create({ data: { productId, durationMin: 60 } });
    courseId = course.id;

    const cred = await credentialService.issue(`${TAG}-rc`, {
      triggersAffiliate: false,
      canIngestRefund: true,
    });
    credName = cred.name;
    credKey = cred.key;
  });

  afterAll(async () => {
    await prisma.commercePayment.deleteMany({ where: { memberId: buyerId } });
    await prisma.commerceTransaction.deleteMany({ where: { memberId: buyerId } });
    await prisma.courseEnrollment.deleteMany({ where: { memberId: buyerId } });
    await prisma.thirdPartyCredential.deleteMany({ where: { name: credName } });
    await prisma.course.delete({ where: { id: courseId } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.member.delete({ where: { id: buyerId } });
    await prisma.$disconnect();
  });

  it('purchase grants access, refund cancels the row without deleting it', async () => {
    const cred = await credentialService.verify(credKey);
    const purchase = await purchaseIngestService.ingest(
      {
        providerEventId: `${TAG}-buy1`,
        type: 'PURCHASE',
        memberRef: { byId: buyerId },
        productRef: { bySku: `${TAG}-sku` },
        grossAmount: 100_000,
      },
      cred!,
    );
    expect(purchase.status).toBe('committed');
    expect(await waitForActiveEnrollment(buyerId, courseId)).toBe(true);

    // Give the enrollment a history worth preserving, so the refund can be shown
    // to keep it and the re-purchase can be shown to reset it.
    await prisma.courseEnrollment.updateMany({
      where: { memberId: buyerId, courseId },
      data: { progress: 42, certificateCode: 'CERT-OLD', certificateCreated: new Date() },
    });

    const refund = await purchaseIngestService.ingest(
      {
        providerEventId: `${TAG}-ref1`,
        type: 'REFUND',
        refundOfProviderEventId: `${TAG}-buy1`,
        memberRef: { byId: buyerId },
        productRef: { bySku: `${TAG}-sku` },
        grossAmount: 100_000,
      },
      cred!,
    );
    expect(refund.status).toBe('refunded');

    const row = await prisma.courseEnrollment.findFirst({ where: { memberId: buyerId, courseId } });
    expect(row).not.toBeNull(); // soft-cancelled, NOT deleted
    expect(row?.isCanceled).toBe(true);
    expect(row?.canceledAt).toBeInstanceOf(Date);
    expect(row?.cancelationReason).toContain('refund:');
    expect(row?.progress).toBe(42); // history survives the refund

    const tx = await prisma.commerceTransaction.findFirst({ where: { memberId: buyerId } });
    expect(tx?.status).toBe('REFUNDED');
  });

  it('a cancelled enrollment grants no access', async () => {
    expect(await hasActiveEnrollment(buyerId, courseId)).toBe(false);
    await expect(mediaService.assertEnrollment(courseId, buyerId)).rejects.toThrow();
  });

  it('a refunded product drops out of "purchased" and returns to the catalog', async () => {
    const listed = await productService.list(PAGE, { memberId: buyerId });
    expect(listed.purchasedProductIds.has(productId)).toBe(false);

    const purchased = await productService.list(PAGE, { memberId: buyerId, ownership: 'purchased' });
    expect(purchased.rows.map((r) => r.id)).not.toContain(productId);

    // The catalog filter is the discovery path for buying again — a cancelled
    // row must not keep hiding the product.
    const notPurchased = await productService.list(PAGE, {
      memberId: buyerId,
      ownership: 'not_purchased',
      keyword: `${TAG}-product`,
    });
    expect(notPurchased.rows.map((r) => r.id)).toContain(productId);
  });

  it('checkout allows re-purchase while the enrollment is cancelled', async () => {
    const res = await checkoutService.start({ memberId: buyerId, productId });
    expect(res.transactionId).toBeTruthy();
    await prisma.commerceTransaction.delete({ where: { id: res.transactionId } });
  });

  it('re-purchase revives the same row and resets progress', async () => {
    const cred = await credentialService.verify(credKey);
    const again = await purchaseIngestService.ingest(
      {
        providerEventId: `${TAG}-buy2`,
        type: 'PURCHASE',
        memberRef: { byId: buyerId },
        productRef: { bySku: `${TAG}-sku` },
        grossAmount: 100_000,
      },
      cred!,
    );
    expect(again.status).toBe('committed');
    expect(await waitForActiveEnrollment(buyerId, courseId)).toBe(true);

    const rows = await prisma.courseEnrollment.findMany({ where: { memberId: buyerId, courseId } });
    expect(rows).toHaveLength(1); // revived, not duplicated
    expect(rows[0].isCanceled).toBe(false);
    expect(rows[0].canceledAt).toBeNull();
    expect(rows[0].cancelationReason).toBeNull();
    expect(rows[0].progress).toBe(0);
    expect(rows[0].certificateCode).toBeNull();
  });

  it('checkout rejects buying a course the member still holds', async () => {
    await expect(checkoutService.start({ memberId: buyerId, productId })).rejects.toMatchObject({
      code: 'PRODUCT_ALREADY_PURCHASED',
    });
  });
});
