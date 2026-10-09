import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { EVENT_TICKET_PRODUCT_TYPE } from '@bb/domain/event/order';
import { shopBaseUrl } from './shop-base-url';

/**
 * Shortlink resolution for `GET /s/:slug`.
 *
 * The stored row holds the ingredients (product or promo, UTM, voucher), never the final
 * URL: the shop origin is a runtime setting and the product's public reference
 * can change, so a frozen URL would rot silently and every already-shared link
 * would keep pointing at the stale target.
 */

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
  /** Shop origin, no trailing slash. Kept as a method for its existing callers. */
  async shopBaseUrl(): Promise<string> {
    return shopBaseUrl();
  }

  /**
   * Resolve a slug to its destination.
   *
   * An unknown slug or an inactive link resolves to the shop home with
   * `linkId: null`; a product with no public reference or a deleted promo goes
   * there too, still counted against the link. A 404 during a live webinar is
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
        promoId: true,
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

    const path = link.promoId
      ? await this.promoPath(link.promoId)
      : await this.productPath(link.productId);
    if (!path) {
      logger.warn(
        { slug: clean, productId: link.productId, promoId: link.promoId },
        link.promoId ? 'shortlink.promo_unusable' : 'shortlink.product_unusable',
      );
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
      url: `${base}${path}?${params.toString()}`,
      linkId: link.id,
    };
  }

  /**
   * Landing path for a promo link. The promo page is served whether or not the
   * promo is still running — an ended promo shows its own "not found" notice
   * with a way into the catalog, and the UTM tag is captured on arrival either
   * way — so only a deleted promo falls back to the shop home.
   */
  private async promoPath(promoId: string): Promise<string | null> {
    const promo = await prisma.promo.findUnique({ where: { id: promoId }, select: { slug: true } });
    return promo ? `/promo/${encodeURIComponent(promo.slug)}` : null;
  }

  /** Landing path for a product link, or null when the product has no public reference. */
  private async productPath(productId: string | null): Promise<string | null> {
    if (!productId) return null;
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: {
        code: true,
        slug: true,
        legacyId: true,
        type: true,
        // A ticket product is one kind of ticket, but the visitor must land on
        // the EVENT — that is the page that carries the story and every tier.
        // Which tier the link happens to name is a bookkeeping detail of
        // `tracking_links.product_id`, not something a buyer should be routed by.
        eventTicketType: { select: { event: { select: { slug: true } } } },
      },
    });

    const eventSlug =
      product?.type === EVENT_TICKET_PRODUCT_TYPE
        ? (product.eventTicketType?.event.slug ?? null)
        : null;
    if (eventSlug) return `/event/${encodeURIComponent(eventSlug)}`;

    // Same preference order the shop route and the visit resolver accept:
    // code -> slug -> legacyId. An event ticket whose type row is missing falls
    // through to the product path rather than to the shop home: a half-wired
    // link should still land the visitor somewhere they can buy.
    const ref = product?.code ?? product?.slug ?? (product?.legacyId?.toString() || null);
    return ref ? `/product/${encodeURIComponent(ref)}` : null;
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
