/**
 * Foreign-storefront purchases are normalised to IDR before they are written.
 *
 * Regression guard for the bug where `price_in_purchased_currency` was stored as rupiah:
 * an A$39.99 purchase landed as `amount = 40` and paid a Rp5 affiliate commission.
 *
 * The FX rate is PINNED via app_settings for these tests, so no network call happens and
 * the expected numbers stay exact. The chain layers below the pin (API → derived → static)
 * are exercised by their own unit-level behaviour, not here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@bb/db';
import { SETTING_KEYS, settingsService } from '@bb/common/services/settings.service';
import { FxRateService } from '@bb/common/services/fx-rate.service';
import { purchaseIngestService } from '@/modules/ingest/purchase-ingest.service';
import { credentialService } from '@/modules/ingest/credential.service';

const TAG = `fx-${Date.now()}`;
const PINNED_RATE = 17_800;
const CATALOG_IOS = 399_000;

describe('ingest: foreign-currency normalization', () => {
  let buyerId = '';
  let productId = '';
  let key = '';
  let credName = '';

  beforeAll(async () => {
    const buyer = await prisma.member.create({
      data: { email: `${TAG}@t.local`, passwordHash: 'x' },
    });
    buyerId = buyer.id;
    const product = await prisma.product.create({
      data: {
        type: 'course',
        title: `${TAG}-p`,
        price: 298_000,
        iosPrice: CATALOG_IOS,
        iosProductId: `${TAG}-ios`,
        androidProductId: `${TAG}-android`,
      },
    });
    productId = product.id;
    const cred = await credentialService.issue(`${TAG}-rc`, { triggersAffiliate: false });
    key = cred.key;
    credName = cred.name;

    await settingsService.set(SETTING_KEYS.fxUsdIdr, String(PINNED_RATE));
    await settingsService.set(SETTING_KEYS.fxUsdIdrPinned, 'true');
    FxRateService.clearCache();
  });

  afterAll(async () => {
    await settingsService.set(SETTING_KEYS.fxUsdIdrPinned, 'false');
    FxRateService.clearCache();
    await prisma.commercePayment.deleteMany({ where: { memberId: buyerId } });
    await prisma.commerceTransaction.deleteMany({ where: { memberId: buyerId } });
    await prisma.courseEnrollment.deleteMany({ where: { memberId: buyerId } });
    await prisma.thirdPartyCredential.deleteMany({ where: { name: credName } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.member.delete({ where: { id: buyerId } });
    await prisma.$disconnect();
  });

  async function ingest(evt: string, extra: Record<string, unknown>) {
    const cred = await credentialService.verify(key);
    const res = await purchaseIngestService.ingest(
      {
        providerEventId: `${TAG}-${evt}`,
        type: 'PURCHASE',
        memberRef: { byId: buyerId },
        productRef: { bySku: `${TAG}-ios` },
        ...extra,
      } as never,
      cred!,
    );
    expect(res.status).toBe('committed');
    return prisma.commercePayment.findUniqueOrThrow({ where: { id: res.paymentId! } });
  }

  it('converts a non-IDR purchase through its USD amount and records the rate', async () => {
    // The exact AUD event that produced the Rp5 commission in production.
    const pay = await ingest('aud', {
      grossAmount: 39.99,
      netAmount: 39.99 * 0.7,
      currency: 'AUD',
      amountUsd: 28.248,
    });

    expect(pay.amount).toBe(Math.round(28.248 * PINNED_RATE)); // 502_814
    expect(pay.acceptedAmount).toBe(Math.floor(pay.amount * 0.7));
    expect(pay.currency).toBe('AUD');
    expect(Number(pay.amountLocal)).toBe(39.99);
    expect(Number(pay.amountUsd)).toBe(28.248);
    expect(Number(pay.fxRateIdr)).toBe(PINNED_RATE);
    expect(pay.fxRateSource).toBe('manual');

    // The whole point: the amount must be of the right ORDER, not local-currency debris.
    expect(pay.amount).toBeGreaterThan(100_000);
  });

  it('leaves an IDR purchase untouched and writes no FX columns', async () => {
    const pay = await ingest('idr', {
      grossAmount: CATALOG_IOS,
      netAmount: CATALOG_IOS * 0.7,
      currency: 'IDR',
      amountUsd: 22.38,
    });

    expect(pay.amount).toBe(CATALOG_IOS);
    expect(pay.acceptedAmount).toBe(Math.floor(CATALOG_IOS * 0.7));
    expect(pay.fxRateIdr).toBeNull();
    expect(pay.fxRateSource).toBeNull();
    expect(pay.amountLocal).toBeNull();
  });

  it('falls back to the catalog price when the event carries no usable USD amount', async () => {
    // Sandbox events arrive with price 0 — without this fallback they would be stored as
    // a free sale.
    const pay = await ingest('nousd', {
      grossAmount: 39.99,
      netAmount: 39.99 * 0.7,
      currency: 'AUD',
      amountUsd: 0,
    });

    expect(pay.amount).toBe(CATALOG_IOS);
    expect(pay.acceptedAmount).toBe(Math.floor(CATALOG_IOS * 0.7));
    expect(pay.fxRateSource).toBe('catalog_fallback');
    expect(pay.fxRateIdr).toBeNull();
  });

  it('refuses a converted amount outside the sanity band', async () => {
    const pay = await ingest('absurd', {
      grossAmount: 39.99,
      netAmount: 39.99 * 0.7,
      currency: 'AUD',
      amountUsd: 1_000_000, // ~17.8bn IDR — far above 4x catalog
    });

    expect(pay.amount).toBe(CATALOG_IOS);
    expect(pay.fxRateSource).toBe('catalog_fallback');
  });

  it('never writes a zero amount when the product has no catalog price', async () => {
    // A product priced 0 gives the sanity band nothing to compare against. Refusing the
    // conversion against a zero catalog would store amount = 0 — a paid purchase reading
    // as a free one. The converted value is kept instead.
    const free = await prisma.product.create({
      data: { type: 'course', title: `${TAG}-free`, price: 0, iosProductId: `${TAG}-free-sku` },
    });
    const cred = await credentialService.verify(key);
    const res = await purchaseIngestService.ingest(
      {
        providerEventId: `${TAG}-free`,
        type: 'PURCHASE',
        memberRef: { byId: buyerId },
        productRef: { bySku: `${TAG}-free-sku` },
        grossAmount: 39.99,
        netAmount: 39.99 * 0.7,
        currency: 'AUD',
        amountUsd: 28.248,
      } as never,
      cred!,
    );
    const pay = await prisma.commercePayment.findUniqueOrThrow({ where: { id: res.paymentId! } });

    expect(pay.amount).toBe(Math.round(28.248 * PINNED_RATE));
    expect(pay.fxRateSource).toBe('manual');
    await prisma.commercePayment.delete({ where: { id: pay.id } });
    await prisma.commerceTransaction.delete({ where: { id: res.transactionId! } });
    await prisma.product.delete({ where: { id: free.id } });
  });

  it('resolves a product by its Google Play SKU', async () => {
    const cred = await credentialService.verify(key);
    const res = await purchaseIngestService.ingest(
      {
        providerEventId: `${TAG}-play`,
        type: 'PURCHASE',
        memberRef: { byId: buyerId },
        productRef: { bySku: `${TAG}-android` },
        grossAmount: CATALOG_IOS,
        currency: 'IDR',
      },
      cred!,
    );

    expect(res.status).toBe('committed');
    const tx = await prisma.commerceTransaction.findUniqueOrThrow({
      where: { id: res.transactionId! },
    });
    expect(tx.productId).toBe(productId);
  });
});
