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
  // Days between a member confirming account deletion and the purge anonymising the
  // row. A policy number — product or a regulator moves it, not a release. Safe to
  // change at any time: the deadline is computed once and stored as an absolute date,
  // so a new value only affects deletions scheduled after it and never pulls an
  // in-flight account forward.
  accountDeletionGraceDays: 'account.deletionGraceDays',
  affiliateCookieDays: 'affiliate.cookieDays',
  affiliateHoldDays: 'affiliate.holdDays',
  affiliateIapHoldDays: 'affiliate.iapHoldDays',
  // Max app version (inclusive) that still SEES banners, one per platform. Empty = gate off.
  // The client sends ?platform=&version= on /data/banner; a newer build gets an empty list.
  bannerMaxVersionAndroid: 'banner.maxVersionAndroid',
  bannerMaxVersionIos: 'banner.maxVersionIos',
  // Minutes a buyer has to pay for event tickets before the seats go back on
  // sale. Separate from the 24h course window on purpose: a course has no quota,
  // so an abandoned checkout costs nobody anything, while an abandoned ticket
  // checkout holds a seat somebody else wanted. Runtime-configurable because the
  // right number depends on the event — a webinar that sells out in minutes wants
  // a tighter hold than a workshop selling for weeks.
  eventCheckoutExpiryMinutes: 'event.checkoutExpiryMinutes',
  // Path of the order page on the web shop, appended to `shop.baseUrl` to build
  // the post-payment redirect of an event invoice. A setting and not a constant
  // because the FE route is not settled: moving it (to `/ticket`, say) is then one
  // UPDATE, with no redeploy and no rebuilt invoice code. Covers the REDIRECT only
  // — bb-comms builds its email link from its own SHOP_BASE_URL plus a hardcoded
  // `/event/order/`, so flipping this does NOT move the links already in inboxes.
  eventOrderPath: 'event.orderPath',
  disbursementAutoEnabled: 'disbursement.autoEnabled',
  disbursementAutoApproveMax: 'disbursement.autoApproveMax',
  disbursementFee: 'disbursement.fee',
  disbursementMinBalance: 'disbursement.minBalance',
  // USD→IDR rate used to normalise foreign-storefront IAP purchases. `fxUsdIdr` is the
  // static floor of the resolution chain; setting `fxUsdIdrPinned` to true promotes it
  // above the FX API, which is the ops kill-switch when the provider misbehaves.
  fxUsdIdr: 'fx.usdIdr',
  fxUsdIdrPinned: 'fx.usdIdrPinned',
  kycMinBalance: 'kyc.minBalance',
  subscriptionGraceDays: 'subscription.graceDays',
  subscriptionReminderDaysBefore: 'subscription.reminderDaysBefore',
  notificationUnopenedPushLimit: 'notification.unopenedPushLimit',
  notificationDigestEnabled: 'notification.digestEnabled',
  notificationDigestHour: 'notification.digestHour',
  salesAlertEmail: 'sales.alertEmail',
  affiliateLeaderboardTopN: 'affiliate.leaderboardTopN',
  uploadOrphanTtlHours: 'upload.orphanTtlHours',
  playlistMaxPerMember: 'playlist.maxPerMember',
  playlistMaxItems: 'playlist.maxItems',
  // Bunny Stream guid of the single global interlude clip, NOT a URL: a raw URL
  // would leak the CDN host + guid past the media proxy, with no rate limit and
  // no way to revoke it. Empty = interlude disabled.
  playlistInterludeAssetId: 'playlist.interludeAssetId',
  playlistRequiresSubscription: 'playlist.requiresSubscription',
  // Origin of the web shop, used to build the target of a shortlink redirect and
  // the URLs shown on the backoffice Tracking Link page. ONE row read by both
  // apps: a second copy in backoffice config is how the redirect starts pointing
  // somewhere the operator never sees.
  shopBaseUrl: 'shop.baseUrl',
  // Listening-tracker thresholds. Grouped under `tracker.` rather than `streak.` so
  // ops finds both together: `qualifySec` is the streak bar, `minSessionSec` is the
  // floor below which a play is a mis-tap rather than a session. Two different
  // questions, and moving either without the other is a legitimate thing to want.
  trackerMinSessionSec: 'tracker.minSessionSec',
  trackerQualifySec: 'tracker.qualifySec',
  // Listening days a member may miss before the streak resets to 0. The window is
  // measured from today, so only a recent gap is forgiven — see tracker.constants.ts.
  streakGraceDays: 'streak.graceDays',
  // A freeze is EARNED, not granted by recency: this many qualifying days inside the
  // current streak earn one. Some limit is mandatory — without it a member who
  // listens every other day has every gap forgiven and their streak becomes "days
  // listened, ever". The rate is the whole limit; no ceiling sits on top of it.
  streakFreezeEarnEvery: 'streak.freezeEarnEvery',
  // Streak reminder push. One switch PER SEND, not one for both: the two answer
  // different moments (an evening nudge vs a morning second chance) and ops must be
  // able to silence one without losing the other. The job runs on the hourly cron
  // tick and only acts on its hour, so moving a send time needs no redeploy.
  streakAtRiskEnabled: 'streak.atRiskEnabled',
  streakDimmedEnabled: 'streak.dimmedEnabled',
  streakAtRiskHour: 'streak.atRiskHour',
  streakDimmedHour: 'streak.dimmedHour',
  // Terms & conditions. `currentVersion` is a free-form label compared with `!==`
  // (bump it ONLY when the document changes — an app release alone must not re-prompt
  // every member). `enabled` ships false: the client gate is the only enforcement, and
  // flipping it on before the app build with the T&C screen exists would only mark
  // every member `needsAcceptance` with nothing able to clear it.
  termsEnabled: 'terms.enabled',
  termsCurrentVersion: 'terms.currentVersion',
  termsUrl: 'terms.url',
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
