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
  // Max app version (inclusive) that still SEES banners, one per platform. Empty = gate off.
  // The client sends ?platform=&version= on /data/banner; a newer build gets an empty list.
  bannerMaxVersionAndroid: 'banner.maxVersionAndroid',
  bannerMaxVersionIos: 'banner.maxVersionIos',
  // App version range (both INCLUSIVE) that sees promos on /promo/public, one pair per
  // platform. Mobile only: a request without ?platform=android|ios (the web shop) is never
  // gated. Empty pair = gate off. Lets a promo run on prod for an internal build only.
  promoMinVersionAndroid: 'promo.minVersionAndroid',
  promoMaxVersionAndroid: 'promo.maxVersionAndroid',
  promoMinVersionIos: 'promo.minVersionIos',
  promoMaxVersionIos: 'promo.maxVersionIos',
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
  // First-purchase voucher program. Five of the six config values ship EMPTY and the
  // switch ships false: the discount, its cap and how long it lives are a business
  // decision the internal team makes in the backoffice, and a dev-chosen default is
  // how a placeholder quietly becomes the number that went out to thousands of
  // buyers. The job refuses to issue anything until they are all filled.
  //
  // `launchAt` is also the blast radius control: only purchases at or after it count,
  // it is stamped by the backoffice when the program is first switched on, and it can
  // never be moved backwards — a past date would mail every historical buyer at once.
  firstPurchaseVoucherEnabled: 'firstPurchaseVoucher.enabled',
  firstPurchaseVoucherLaunchAt: 'firstPurchaseVoucher.launchAt',
  firstPurchaseVoucherType: 'firstPurchaseVoucher.type',
  firstPurchaseVoucherValue: 'firstPurchaseVoucher.value',
  firstPurchaseVoucherMaxAmount: 'firstPurchaseVoucher.maxAmount',
  firstPurchaseVoucherValidityDays: 'firstPurchaseVoucher.validityDays',
  // Sweep watermark, written by the job itself — not an operator setting. Kept in
  // `app_settings` rather than `sync_state` because that table belongs to
  // apps/resync-worker, which is deleted at cutover.
  firstPurchaseVoucherLastSweepAt: 'firstPurchaseVoucher.lastSweepAt',
  kycMinBalance: 'kyc.minBalance',
  // AI moderation of tribe posts, text and images (docs/tribe-moderation.md). Any
  // OpenAI-compatible chat-completions endpoint. ON only when `enabled` is true,
  // the other three are non-empty AND at least one moderation category is active;
  // anything less and posts publish exactly as before. The API key lives here, in
  // the DB, by product decision — never log it.
  moderationEnabled: 'moderation.enabled',
  moderationBaseUrl: 'moderation.baseUrl',
  moderationModel: 'moderation.model',
  moderationApiKey: 'moderation.apiKey',
  notificationUnopenedPushLimit: 'notification.unopenedPushLimit',
  notificationDigestEnabled: 'notification.digestEnabled',
  notificationDigestHour: 'notification.digestHour',
  salesAlertEmail: 'sales.alertEmail',
  // Origin of the web shop, used to build the target of a shortlink redirect and
  // the URLs shown on the backoffice Tracking Link page. ONE row read by both
  // apps: a second copy in backoffice config is how the redirect starts pointing
  // somewhere the operator never sees.
  shopBaseUrl: 'shop.baseUrl',
  // Listening days a member may miss before the streak resets to 0. The window is
  // measured from today, so only a recent gap is forgiven — see tracker.constants.ts.
  streakGraceDays: 'streak.graceDays',
  // Streak reminder push. One switch PER SEND, not one for both: the two answer
  // different moments (an evening nudge vs a morning second chance) and ops must be
  // able to silence one without losing the other. The job runs on the hourly cron
  // tick and only acts on its hour, so moving a send time needs no redeploy.
  streakAtRiskEnabled: 'streak.atRiskEnabled',
  streakDimmedEnabled: 'streak.dimmedEnabled',
  streakAtRiskHour: 'streak.atRiskHour',
  streakDimmedHour: 'streak.dimmedHour',
  // Checkout PPN. `enabled` is the switch (ships false), `rate` the percent
  // (11 = 11%, ships 0). Two keys on purpose: the rate can be staged ahead of
  // go-live, and switching tax off is one flip that does not forget the rate.
  // Flipping `enabled` is a PRODUCT switch, not a knob: every new order from
  // that minute is billed tax-inclusive with no redeploy. Frozen per order, so
  // orders already placed never move. See docs/checkout-tax.md.
  taxEnabled: 'tax.enabled',
  taxRate: 'tax.rate',
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
