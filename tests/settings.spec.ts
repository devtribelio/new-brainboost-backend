/**
 * SettingsService — DB-backed runtime config with cache. Requires a Postgres test DB
 * that has the app_settings table (migration 20260521160000_app_settings).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@/config/prisma';
import { SettingsService, settingsService } from '@/common/services/settings.service';

const TAG = `setting-${Date.now()}`;

describe('SettingsService', () => {
  const keys: string[] = [];

  afterAll(async () => {
    if (keys.length) await prisma.appSetting.deleteMany({ where: { key: { in: keys } } });
    await prisma.$disconnect();
  });

  it('returns the fallback when the key is absent', async () => {
    SettingsService.clearCache();
    expect(await settingsService.get(`${TAG}.absent`, 'def')).toBe('def');
    expect(await settingsService.getNumber(`${TAG}.absentNum`, 42)).toBe(42);
  });

  it('set then get returns the stored value (no restart needed)', async () => {
    const k = `${TAG}.cookieDays`;
    keys.push(k);
    await settingsService.set(k, '180', 'test cookie days');
    expect(await settingsService.getNumber(k, 365)).toBe(180);
  });

  it('reflects an out-of-band DB change after cache clears (runtime-configurable)', async () => {
    const k = `${TAG}.holdDays`;
    keys.push(k);
    await settingsService.set(k, '7');
    expect(await settingsService.getNumber(k, 7)).toBe(7);
    // operator edits the row directly in the DB:
    await prisma.appSetting.update({ where: { key: k }, data: { value: '3' } });
    SettingsService.clearCache();
    expect(await settingsService.getNumber(k, 7)).toBe(3);
  });
});
