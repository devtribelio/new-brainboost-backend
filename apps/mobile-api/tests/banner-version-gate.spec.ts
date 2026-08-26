import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '@bb/db';
import {
  settingsService,
  SETTING_KEYS,
  SettingsService,
} from '@bb/common/services/settings.service';
import { BannerService } from '../src/modules/banner/banner.service';

const PAGE = { page: 1, perPage: 10, skip: 0, take: 10 };

async function setMax(key: string, value: string) {
  await settingsService.set(key, value);
  SettingsService.clearCache();
}

describe('BannerService version gate', () => {
  const service = new BannerService();
  let bannerId = '';

  beforeAll(async () => {
    const b = await prisma.banner.create({
      data: { title: `gate-${Math.random().toString(36).slice(2, 10)}`, imageUrl: 'x.jpg' },
    });
    bannerId = b.id;
  });

  beforeEach(async () => {
    await setMax(SETTING_KEYS.bannerMaxVersionAndroid, '3.3.0');
    await setMax(SETTING_KEYS.bannerMaxVersionIos, '3.3.0');
  });

  afterAll(async () => {
    await prisma.banner.delete({ where: { id: bannerId } });
    await setMax(SETTING_KEYS.bannerMaxVersionAndroid, '');
    await setMax(SETTING_KEYS.bannerMaxVersionIos, '');
  });

  it('shows banners on the max version itself (inclusive)', async () => {
    const r = await service.listActive(PAGE, undefined, { platform: 'android', version: '3.3.0' });
    expect(r.total).toBeGreaterThan(0);
  });

  it('shows banners below the max version', async () => {
    const r = await service.listActive(PAGE, undefined, { platform: 'ios', version: '3.2.9' });
    expect(r.total).toBeGreaterThan(0);
  });

  it('hides banners above the max version', async () => {
    const r = await service.listActive(PAGE, undefined, { platform: 'android', version: '3.3.1' });
    expect(r).toEqual({ rows: [], total: 0 });
  });

  it('compares numerically, not as strings (3.10.0 > 3.3.0)', async () => {
    const r = await service.listActive(PAGE, undefined, { platform: 'android', version: '3.10.0' });
    expect(r).toEqual({ rows: [], total: 0 });
  });

  it('gates each platform independently', async () => {
    await setMax(SETTING_KEYS.bannerMaxVersionIos, '4.0.0');
    const android = await service.listActive(PAGE, undefined, {
      platform: 'android',
      version: '3.5.0',
    });
    const ios = await service.listActive(PAGE, undefined, { platform: 'ios', version: '3.5.0' });
    expect(android.total).toBe(0);
    expect(ios.total).toBeGreaterThan(0);
  });

  it('fails open when the client sends no platform/version (pre-gate builds)', async () => {
    const none = await service.listActive(PAGE);
    const noVersion = await service.listActive(PAGE, undefined, { platform: 'android' });
    const unknownPlatform = await service.listActive(PAGE, undefined, {
      platform: 'web',
      version: '9.9.9',
    });
    expect(none.total).toBeGreaterThan(0);
    expect(noVersion.total).toBeGreaterThan(0);
    expect(unknownPlatform.total).toBeGreaterThan(0);
  });

  it('fails open on an unparseable version', async () => {
    const r = await service.listActive(PAGE, undefined, { platform: 'ios', version: 'nightly' });
    expect(r.total).toBeGreaterThan(0);
  });

  it('is off when the setting is empty', async () => {
    await setMax(SETTING_KEYS.bannerMaxVersionAndroid, '');
    const r = await service.listActive(PAGE, undefined, { platform: 'android', version: '9.9.9' });
    expect(r.total).toBeGreaterThan(0);
  });
});
