import { prisma } from '@bb/db';
import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import { AFFILIATE_COOKIE_DAYS_DEFAULT } from './constants';

/**
 * Resolves the per-purchase commission "override" affiliator (last-touch), shared by web
 * checkout and 3rd-party ingestion so attribution is consistent across channels.
 *
 * Precedence:
 *   1. explicit affiliate code for THIS purchase (web cookie / app deeplink param / provider metadata)
 *   2. most-recent AffiliateVisit within the configurable window (app_settings: affiliate.cookieDays).
 *      STRICT per-product (B-5): when `productId` is given, ONLY a visit scoped to that exact product
 *      attributes. Product-less visits (productId IS NULL) and visits for a DIFFERENT product are
 *      ignored — closing both the "click link for X, buy Y" leak and the product-less last-touch leak.
 *   3. null → engine then falls back to the buyer's permanent inviterId
 *
 * ROLLOUT NOTE: strict mode requires the app to send `productCode` on visits (M-4). Until that
 * ships+adopts, app visits are product-less → they will NOT attribute via visit and fall through
 * to the buyer's inviter. This was an explicit product decision (precision over transition coverage).
 */
export class AttributionService {
  async resolveOverrideAffiliatorMemberId(
    buyerMemberId: string,
    explicitCode?: string | null,
    productId?: string | null,
  ): Promise<string | null> {
    if (explicitCode) {
      const code = explicitCode.slice(0, 8); // first 8 chars = member code (rest = network suffix)
      const m = await prisma.member.findUnique({
        where: { affiliateCode: code },
        select: { id: true },
      });
      if (m && m.id !== buyerMemberId) return m.id;
    }

    const days = await settingsService.getNumber(
      SETTING_KEYS.affiliateCookieDays,
      AFFILIATE_COOKIE_DAYS_DEFAULT,
    );
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const pickVisit = async (where: Record<string, unknown>): Promise<string | null> => {
      const visit = await prisma.affiliateVisit.findFirst({
        where: { memberId: buyerMemberId, createdAt: { gte: since }, ...where },
        orderBy: { createdAt: 'desc' },
        select: { affiliatorMemberId: true },
      });
      return visit && visit.affiliatorMemberId !== buyerMemberId ? visit.affiliatorMemberId : null;
    };

    if (productId !== undefined && productId !== null) {
      // STRICT per-product (B-5): ONLY a visit scoped to THIS product attributes.
      // Product-less visits (productId IS NULL — legacy pre-B5, web/program links,
      // or app builds that don't yet send productCode) and other-product visits are
      // intentionally IGNORED. No match → null → engine falls back to buyer inviter.
      return pickVisit({ productId });
    }

    // No product context at all (caller didn't supply productId) → latest visit of
    // any product. Both production callers (IAP ingest + web checkout) DO pass
    // productId, so this is a defensive fallback only.
    return pickVisit({});
  }
}

export const attributionService = new AttributionService();
