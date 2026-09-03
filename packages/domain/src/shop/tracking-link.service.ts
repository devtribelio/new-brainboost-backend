import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';

/**
 * Shortlink resolution for `GET /s/:slug`.
 *
 * The stored row holds the ingredients (product, UTM, voucher), never the final
 * URL: the shop origin is a runtime setting and the product's public reference
 * can change, so a frozen URL would rot silently and every already-shared link
 * would keep pointing at the stale target.
 */

/** Last-resort shop origin. Overridden by `app_settings['shop.baseUrl']`. */
export const SHOP_BASE_URL_FALLBACK = 'https://brainboost.id';

/**
 * Bot/preview fetchers. Same list as the shop visit logger: with a shortlink in
 * front of a WhatsApp broadcast, every unfurl hits the redirect, and counting
 * those makes the Klik column read as reach when it is one message.
 */
const BOT_UA =
  /bot|crawler|spider|crawling|preview|facebookexternalhit|slackbot|whatsapp|telegrambot|twitterbot|discordbot|embedly|quora link preview|pinterest|redditbot|applebot|bingpreview|headlesschrome|python-requests|curl\/|wget\//i;

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Midnight of the WIB calendar day a moment falls in, as a UTC-midnight Date. */
function wibDay(at: Date): Date {
  const shifted = new Date(at.getTime() + WIB_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}

export interface ShortlinkTarget {
  /** Absolute URL to redirect to. */
  url: string;
  /** Null when the slug matched nothing usable — the caller sends the visitor to
   *  the shop home rather than an error page. */
  linkId: string | null;
}

export class TrackingLinkService {
  /** Shop origin, no trailing slash. */
  async shopBaseUrl(): Promise<string> {
    const raw = await settingsService.get(SETTING_KEYS.shopBaseUrl, SHOP_BASE_URL_FALLBACK);
    return raw.trim().replace(/\/+$/, '');
  }

  /**
   * Resolve a slug to its destination.
   *
   * An unknown slug, an inactive link, or a product with no public reference all
   * resolve to the shop home with `linkId: null`. A 404 during a live webinar is
   * a lost participant; the miss is logged instead so a typo still surfaces.
   */
  async resolve(slug: string): Promise<ShortlinkTarget> {
    const base = await this.shopBaseUrl();
    const clean = slug.trim().toLowerCase();
    if (!clean) return { url: base, linkId: null };

    const link = await prisma.trackingLink.findUnique({
      where: { slug: clean },
      select: {
        id: true,
        isActive: true,
        productId: true,
        utmSource: true,
        utmMedium: true,
        utmCampaign: true,
        utmContent: true,
        utmTerm: true,
        voucherCode: true,
      },
    });
    if (!link || !link.isActive) {
      logger.warn({ slug: clean, found: !!link }, 'shortlink.miss');
      return { url: base, linkId: null };
    }

    const product = await prisma.product.findUnique({
      where: { id: link.productId },
      select: { code: true, slug: true, legacyId: true },
    });
    // Same preference order the shop route and the visit resolver accept:
    // code -> slug -> legacyId.
    const ref = product?.code ?? product?.slug ?? (product?.legacyId?.toString() || null);
    if (!ref) {
      logger.warn({ slug: clean, productId: link.productId }, 'shortlink.product_unusable');
      return { url: base, linkId: link.id };
    }

    const params = new URLSearchParams();
    params.set('utm_source', link.utmSource);
    if (link.utmMedium) params.set('utm_medium', link.utmMedium);
    params.set('utm_campaign', link.utmCampaign);
    if (link.utmContent) params.set('utm_content', link.utmContent);
    if (link.utmTerm) params.set('utm_term', link.utmTerm);
    if (link.voucherCode) params.set('voucher', link.voucherCode);

    return {
      url: `${base}/product/${encodeURIComponent(ref)}?${params.toString()}`,
      linkId: link.id,
    };
  }

  /**
   * Bump today's click counter. Never throws: a failed counter must not cost the
   * visitor their redirect, which is the only part of this that matters.
   */
  async recordClick(linkId: string, userAgent?: string, at = new Date()): Promise<void> {
    if (userAgent && BOT_UA.test(userAgent)) return;
    const day = wibDay(at);
    try {
      await prisma.$executeRaw`
        INSERT INTO tracking_link_clicks (link_id, day, count)
        VALUES (${linkId}::uuid, ${day}::date, 1)
        ON CONFLICT (link_id, day) DO UPDATE SET count = tracking_link_clicks.count + 1
      `;
    } catch (err) {
      logger.warn({ err, linkId }, 'shortlink.click_write_failed');
    }
  }
}

export const trackingLinkService = new TrackingLinkService();
