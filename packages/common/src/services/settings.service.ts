import { prisma } from '@bb/db';

/**
 * Runtime-configurable settings backed by the `app_settings` table.
 * Cached in-memory with a short TTL so values can be changed in the DB (or via an admin
 * endpoint) WITHOUT a redeploy/restart — changes propagate within CACHE_TTL_MS.
 *
 * get(key, fallback) returns the fallback when the row is absent, so the app keeps working
 * even before the settings are seeded.
 */
const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  value: string;
  expiresAt: number;
}

/** Stable keys for known settings (avoid typos across the codebase). */
export const SETTING_KEYS = {
  affiliateCookieDays: 'affiliate.cookieDays',
  affiliateHoldDays: 'affiliate.holdDays',
  affiliateIapHoldDays: 'affiliate.iapHoldDays',
  disbursementAutoEnabled: 'disbursement.autoEnabled',
  disbursementAutoApproveMax: 'disbursement.autoApproveMax',
  disbursementFee: 'disbursement.fee',
  disbursementMinBalance: 'disbursement.minBalance',
  kycMinBalance: 'kyc.minBalance',
  subscriptionGraceDays: 'subscription.graceDays',
  subscriptionReminderDaysBefore: 'subscription.reminderDaysBefore',
  salesAlertEmail: 'sales.alertEmail',
} as const;

export class SettingsService {
  private static cache = new Map<string, CacheEntry>();

  async get(key: string, fallback: string): Promise<string> {
    const now = Date.now();
    const hit = SettingsService.cache.get(key);
    if (hit && hit.expiresAt > now) return hit.value;

    const row = await prisma.appSetting.findUnique({ where: { key }, select: { value: true } });
    const value = row?.value ?? fallback;
    SettingsService.cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
    return value;
  }

  async getNumber(key: string, fallback: number): Promise<number> {
    const raw = await this.get(key, String(fallback));
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  async getBoolean(key: string, fallback: boolean): Promise<boolean> {
    const raw = (await this.get(key, String(fallback))).trim().toLowerCase();
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    return fallback;
  }

  async set(key: string, value: string, description?: string): Promise<void> {
    await prisma.appSetting.upsert({
      where: { key },
      create: { key, value, description },
      update: { value, ...(description !== undefined ? { description } : {}) },
    });
    SettingsService.cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  /** Drop the in-memory cache (tests, or to force an immediate reload). */
  static clearCache(): void {
    SettingsService.cache.clear();
  }
}

export const settingsService = new SettingsService();
