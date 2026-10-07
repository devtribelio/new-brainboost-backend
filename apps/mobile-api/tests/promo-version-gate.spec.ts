import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '@bb/db';
import {
  settingsService,
  SETTING_KEYS,
  SettingsService,
} from '@bb/common/services/settings.service';
import { PromoService, type PromoClientInfo } from '../src/modules/promo/promo.service';
import { ProductService } from '../src/modules/product/product.service';

const TAG = `pvg${Date.now().toString(36)}`;
const RANGE_KEYS = [
  SETTING_KEYS.promoMinVersionAndroid,
  SETTING_KEYS.promoMaxVersionAndroid,
  SETTING_KEYS.promoMinVersionIos,
  SETTING_KEYS.promoMaxVersionIos,
];

async function setSetting(key: string, value: string) {
  await settingsService.set(key, value);
  SettingsService.clearCache();
}

describe('PromoService version gate', () => {
  const service = new PromoService(new ProductService());
  let productId = '';
  let voucherId = '';
  let promoId = '';

  /** Whether the tagged promo is in the list — the shared DB may hold other promos. */
  async function sees(client?: PromoClientInfo): Promise<boolean> {
    const { promos } = await service.listActive(undefined, client);
    return promos.some((p) => p.slug === TAG);
  }

  beforeAll(async () => {
    const product = await prisma.product.create({
      data: { type: 'course', title: `${TAG} course`, price: 100000, isActive: true, status: 'active' },
    });
    productId = product.id;
    const voucher = await prisma.voucher.create({
      data: { code: TAG.toUpperCase(), type: 'PERCENT', value: 30 },
    });
    voucherId = voucher.id;
    const promo = await prisma.promo.create({
      data: { slug: TAG, title: TAG, voucherId, products: { create: [{ productId }] } },
    });
    promoId = promo.id;
  });

  beforeEach(async () => {
    // Window 3.3.2 – 3.4.0 on both platforms.
    await setSetting(SETTING_KEYS.promoMinVersionAndroid, '3.3.2');
    await setSetting(SETTING_KEYS.promoMaxVersionAndroid, '3.4.0');
    await setSetting(SETTING_KEYS.promoMinVersionIos, '3.3.2');
    await setSetting(SETTING_KEYS.promoMaxVersionIos, '3.4.0');
  });

  afterAll(async () => {
    await prisma.promo.delete({ where: { id: promoId } });
    await prisma.voucher.delete({ where: { id: voucherId } });
    await prisma.product.delete({ where: { id: productId } });
    for (const key of RANGE_KEYS) await setSetting(key, '');
  });

  it('shows promos on both bounds (inclusive)', async () => {
    expect(await sees({ platform: 'android', version: '3.3.2' })).toBe(true);
    expect(await sees({ platform: 'ios', version: '3.4.0' })).toBe(true);
  });

  it('hides promos below min and above max', async () => {
    expect(await sees({ platform: 'android', version: '3.3.1' })).toBe(false);
    expect(await sees({ platform: 'ios', version: '3.4.1' })).toBe(false);
  });

  it('compares numerically, not as strings (3.10.0 > 3.4.0)', async () => {
    expect(await sees({ platform: 'android', version: '3.10.0' })).toBe(false);
  });

  it('never gates the web: no platform, or a platform that is not mobile', async () => {
    expect(await sees()).toBe(true);
    expect(await sees({ version: '1.0.0' })).toBe(true);
    expect(await sees({ platform: 'web', version: '1.0.0' })).toBe(true);
  });

  it('fails closed on mobile when the version is missing or unparseable', async () => {
    expect(await sees({ platform: 'android' })).toBe(false);
    expect(await sees({ platform: 'ios', version: 'nightly' })).toBe(false);
  });

  it('applies a one-sided window (min only = this build and newer)', async () => {
    await setSetting(SETTING_KEYS.promoMaxVersionAndroid, '');
    expect(await sees({ platform: 'android', version: '9.9.9' })).toBe(true);
    expect(await sees({ platform: 'android', version: '3.3.1' })).toBe(false);
  });

  it('gates each platform independently', async () => {
    await setSetting(SETTING_KEYS.promoMinVersionIos, '');
    await setSetting(SETTING_KEYS.promoMaxVersionIos, '');
    expect(await sees({ platform: 'android', version: '3.3.0' })).toBe(false);
    expect(await sees({ platform: 'ios', version: '3.3.0' })).toBe(true);
  });

  it('is off when both bounds are empty, even with no version', async () => {
    await setSetting(SETTING_KEYS.promoMinVersionAndroid, '');
    await setSetting(SETTING_KEYS.promoMaxVersionAndroid, '');
    expect(await sees({ platform: 'android' })).toBe(true);
    expect(await sees({ platform: 'android', version: '1.0.0' })).toBe(true);
  });
});
