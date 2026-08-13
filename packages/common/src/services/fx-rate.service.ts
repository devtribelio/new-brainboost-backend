import { prisma } from '@bb/db';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { SETTING_KEYS, settingsService } from './settings.service';

/**
 * USD→IDR lookup for purchases settled in a foreign currency.
 *
 * WHY ONLY USD→IDR: RevenueCat sends `price` in USD on every event regardless of
 * storefront, having already converted from the buyer's currency. So one pair covers
 * AUD/HKD/SGD/MYR and every storefront we have not seen yet — we never store, or need,
 * a per-currency rate.
 *
 * RESOLUTION CHAIN — first layer that answers wins. It never dead-ends: the caller's own
 * catalog-price fallback is the floor below layer 5.
 *
 *   1. in-process cache, keyed by UTC day
 *   2. pinned setting            (ops kill-switch, beats the API on purpose)
 *   3. FX API                    (primary → fallback provider)
 *   4. derived from our own IDR RevenueCat payments
 *   5. static setting / env
 *
 * Layer 4 is the interesting one: an IDR event carries BOTH sides of the pair
 * (`price_in_purchased_currency / price`), so its ratio is the exact rate RevenueCat
 * billed with that day. It is a fallback rather than the primary source only because it
 * requires a recent IDR sale to exist — a dependency worth avoiding for the hot path,
 * but perfectly good when the API is down.
 *
 * Cadence: ECB publishes once per business day, so the day-keyed cache matches the
 * source's own rhythm — calling more often cannot produce a new number.
 */

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — bounded so a long-lived process still re-checks

export type FxRateSource = 'manual' | 'api' | 'revenuecat_derived' | 'static';

export interface FxRateResult {
  rate: number;
  source: FxRateSource;
}

interface CacheEntry {
  result: FxRateResult;
  expiresAt: number;
}

/** UTC day key. Deliberately UTC: `paidAt` is stored UTC, so the key is stable. */
function dayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function isUsableRate(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

export class FxRateService {
  private static cache = new Map<string, CacheEntry>();

  /**
   * Resolve the USD→IDR rate to convert a purchase made at `at`.
   * Returns null only when every layer failed — the caller then falls back to the
   * product's catalog price and records `fx_rate_source = 'catalog_fallback'`.
   */
  async getUsdIdr(at: Date = new Date()): Promise<FxRateResult | null> {
    const key = dayKey(at);
    const now = Date.now();

    const hit = FxRateService.cache.get(key);
    if (hit && hit.expiresAt > now) return hit.result;

    const resolved =
      (await this.fromPinnedSetting()) ??
      (await this.fromApi(key)) ??
      (await this.fromRevenueCatEvents(at)) ??
      (await this.fromStaticSetting());

    if (resolved) {
      FxRateService.cache.set(key, { result: resolved, expiresAt: now + CACHE_TTL_MS });
    }
    return resolved;
  }

  /** Layer 2 — ops override. Only honoured while `fx.usdIdrPinned` is true. */
  private async fromPinnedSetting(): Promise<FxRateResult | null> {
    try {
      const pinned = await settingsService.getBoolean(SETTING_KEYS.fxUsdIdrPinned, false);
      if (!pinned) return null;
      const rate = await settingsService.getNumber(
        SETTING_KEYS.fxUsdIdr,
        env.fx.staticUsdIdr,
      );
      if (!isUsableRate(rate)) return null;
      logger.info({ rate }, '[fx] using pinned USD/IDR rate');
      return { rate, source: 'manual' };
    } catch (err) {
      logger.warn({ err }, '[fx] pinned setting lookup failed');
      return null;
    }
  }

  /** Layer 3 — keyless FX providers, primary then fallback. */
  private async fromApi(day: string): Promise<FxRateResult | null> {
    const primary = await this.fetchJson(
      `${env.fx.primaryUrl}/${day}?base=USD&symbols=IDR`,
    );
    // Frankfurter echoes the date it actually served (weekends/holidays resolve back
    // to the last business day) — logged so a converted row can be traced to a
    // publication date, not just the day we asked about.
    const primaryRate = (primary as { rates?: { IDR?: number } } | null)?.rates?.IDR;
    if (isUsableRate(primaryRate)) {
      logger.info(
        { rate: primaryRate, asked: day, served: (primary as { date?: string }).date },
        '[fx] USD/IDR from primary provider',
      );
      return { rate: primaryRate, source: 'api' };
    }

    const fallback = await this.fetchJson(env.fx.fallbackUrl);
    const fallbackRate = (fallback as { rates?: { IDR?: number } } | null)?.rates?.IDR;
    if (isUsableRate(fallbackRate)) {
      logger.warn(
        { rate: fallbackRate, day },
        '[fx] primary provider unavailable — used fallback provider',
      );
      return { rate: fallbackRate, source: 'api' };
    }

    return null;
  }

  private async fetchJson(url: string): Promise<unknown | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.fx.timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        logger.warn({ url, status: res.status }, '[fx] provider returned non-2xx');
        return null;
      }
      return await res.json();
    } catch (err) {
      logger.warn({ url, err }, '[fx] provider request failed');
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Layer 4 — derive from our own IDR RevenueCat events. Each carries both legs of the
   * pair, so the ratio is exactly what RevenueCat billed the customer with. Looks
   * BACKWARD only: a live webhook cannot see purchases that have not happened yet.
   */
  private async fromRevenueCatEvents(at: Date): Promise<FxRateResult | null> {
    try {
      const cutoff = new Date(at.getTime() - env.fx.derivedMaxAgeDays * 86_400_000);
      const rows = await prisma.$queryRaw<Array<{ rate: number | null }>>`
        SELECT (log_request->>'price_in_purchased_currency')::numeric
             / NULLIF((log_request->>'price')::numeric, 0) AS rate
        FROM commerce_payments
        WHERE payment_type = 'revenuecat'
          AND log_request->>'currency' = 'IDR'
          AND (log_request->>'price')::numeric > 0
          AND paid_at <= ${at}
          AND paid_at >= ${cutoff}
        ORDER BY paid_at DESC
        LIMIT 1
      `;
      const rate = rows[0]?.rate != null ? Number(rows[0].rate) : null;
      if (!isUsableRate(rate)) return null;
      logger.warn({ rate }, '[fx] FX providers unavailable — derived rate from IDR events');
      return { rate, source: 'revenuecat_derived' };
    } catch (err) {
      logger.warn({ err }, '[fx] derived-rate lookup failed');
      return null;
    }
  }

  /** Layer 5 — static floor. */
  private async fromStaticSetting(): Promise<FxRateResult | null> {
    try {
      const rate = await settingsService.getNumber(SETTING_KEYS.fxUsdIdr, env.fx.staticUsdIdr);
      if (!isUsableRate(rate)) return null;
      logger.error({ rate }, '[fx] every live source failed — using static USD/IDR rate');
      return { rate, source: 'static' };
    } catch {
      const rate = env.fx.staticUsdIdr;
      if (!isUsableRate(rate)) return null;
      logger.error({ rate }, '[fx] settings unreachable — using env static USD/IDR rate');
      return { rate, source: 'static' };
    }
  }

  /** Drop the in-memory cache (tests, or to force an immediate reload). */
  static clearCache(): void {
    FxRateService.cache.clear();
  }
}

export const fxRateService = new FxRateService();
