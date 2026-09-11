import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';

/** Last-resort shop origin. Overridden by `app_settings['shop.baseUrl']`. */
export const SHOP_BASE_URL_FALLBACK = 'https://brainboost.id';

/**
 * Origin of the web shop, with any trailing slash removed so callers can append a
 * path without producing `//`.
 *
 * One function, because `app_settings['shop.baseUrl']` is deliberately one row:
 * a second copy of this resolution is how a shortlink and an invoice redirect
 * start pointing at different hosts, with nothing on screen to say so.
 */
export async function shopBaseUrl(): Promise<string> {
  const raw = await settingsService.get(SETTING_KEYS.shopBaseUrl, SHOP_BASE_URL_FALLBACK);
  return raw.trim().replace(/\/+$/, '');
}
