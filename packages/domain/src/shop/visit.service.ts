import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';

/** Window a guest's visits stay claimable after login. Kept equal to the
 *  affiliate cookie window (COOKIE_DAYS) — if one moves, move both. */
const CLAIM_WINDOW_DAYS = 30;

/** Every UTM field is stored verbatim; only length is bounded so a crafted URL
 *  can't write unbounded rows. Truncate, never reject — a marketing link that
 *  errors is a lost visit. */
const MAX_FIELD_LEN = 255;

/** Bot/preview fetchers (WhatsApp + Slack unfurl, mail scanners, crawlers).
 *  With a shortlink in front these are a real share of raw hits, and they would
 *  inflate both Kunjungan and Pengunjung unik. */
const BOT_UA = /bot|crawler|spider|crawling|preview|facebookexternalhit|slackbot|whatsapp|telegrambot|twitterbot|discordbot|embedly|quora link preview|pinterest|redditbot|applebot|bingpreview|headlesschrome|python-requests|curl\/|wget\//i;

export interface ShopVisitInput {
  guestId?: string;
  productCode?: string;
  memberId?: string | null;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  referer?: string;
  ipAddress?: string;
  userAgent?: string;
  clientEventId?: string;
}

export interface ShopVisitResult {
  status: 'logged' | 'duplicate' | 'invalid' | 'error';
}

export class ShopVisitService {
  /**
   * Record a tracking-link visit. Like the affiliate visit logger this NEVER
   * throws and the caller always answers 200: a marketing link that returns
   * 4xx/5xx loses the click it exists to measure.
   */
  async logVisit(input: ShopVisitInput): Promise<ShopVisitResult> {
    try {
      const guestId = trim(input.guestId);
      if (!guestId) return { status: 'invalid' };

      // Dropped before the write, not filtered at read time: an unfurl bot is
      // not a visitor, and leaving the rows in would inflate `distinct guest_id`
      // (each unfurl carries a fresh cookie-less guest id) with no way to tell
      // them apart later.
      if (input.userAgent && BOT_UA.test(input.userAgent)) return { status: 'invalid' };

      const clientEventId = trim(input.clientEventId);
      if (clientEventId) {
        const existing = await prisma.shopVisit.findUnique({
          where: { clientEventId },
          select: { id: true },
        });
        if (existing) return { status: 'duplicate' };
      }

      const productId = await this.resolveProductId(input.productCode);

      await prisma.shopVisit.create({
        data: {
          guestId,
          memberId: input.memberId ?? null,
          productId,
          utmSource: trim(input.utmSource),
          utmMedium: trim(input.utmMedium),
          utmCampaign: trim(input.utmCampaign),
          utmContent: trim(input.utmContent),
          utmTerm: trim(input.utmTerm),
          referer: trim(input.referer),
          ipAddress: trim(input.ipAddress),
          userAgent: trim(input.userAgent),
          clientEventId,
        },
        select: { id: true },
      });

      return { status: 'logged' };
    } catch (err) {
      // Includes the P2002 lost by a concurrent double-send of the same
      // clientEventId — the row exists either way, which is what 'duplicate'
      // means to the caller.
      logger.warn({ err }, 'shop.visit.write_failed');
      return { status: 'error' };
    }
  }

  /**
   * Bind a guest's visits to the member who just authenticated. Called once
   * after ANY successful auth (email register, password login, Google) — which
   * is why attribution does not ride on the register payload: `LoginDto` has no
   * UTM fields and the social create path would otherwise land every Google
   * signup in `direct`.
   *
   * Idempotent: only rows still unclaimed are touched.
   */
  async claimForMember(memberId: string, guestId: string): Promise<{ claimed: number }> {
    const gid = trim(guestId);
    if (!gid) return { claimed: 0 };

    const since = new Date(Date.now() - CLAIM_WINDOW_DAYS * 24 * 3600 * 1000);
    const res = await prisma.shopVisit.updateMany({
      where: { guestId: gid, memberId: null, createdAt: { gte: since } },
      data: { memberId },
    });
    return { claimed: res.count };
  }

  /**
   * Resolve a shop product reference to a Product.id, accepting the same forms
   * the product detail route does — legacyId (strict numeric) | code | slug.
   * Unknown/absent degrades to a product-less visit; it never rejects a click.
   */
  private async resolveProductId(productCode?: string): Promise<string | null> {
    const input = trim(productCode);
    if (!input) return null;

    const legacyId = Number.parseInt(input, 10);
    if (Number.isFinite(legacyId) && input === String(legacyId)) {
      const byLegacy = await prisma.product.findUnique({
        where: { legacyId },
        select: { id: true },
      });
      if (byLegacy) return byLegacy.id;
    }
    const byCode = await prisma.product.findUnique({ where: { code: input }, select: { id: true } });
    if (byCode) return byCode.id;
    // slug is not unique -> first match, deterministic (UUID v7 is time-ordered).
    const bySlug = await prisma.product.findFirst({
      where: { slug: input },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    return bySlug?.id ?? null;
  }
}

function trim(value?: string | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const out = value.trim().slice(0, MAX_FIELD_LEN);
  return out.length > 0 ? out : undefined;
}
