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
 *      Per-product (B-5): when `productId` is given, an exact-product visit wins; only when none
 *      exists do we fall back to a product-less visit (legacy/web/program link). A visit scoped to
 *      a DIFFERENT product never attributes — that closes the "click link for X, buy Y" leakage.
 *   3. null → engine then falls back to the buyer's permanent inviterId
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
      // Tier 1: a visit scoped to THIS product (B-5 precise attribution).
      const exact = await pickVisit({ productId });
      if (exact) return exact;
      // Tier 2: a product-less visit (legacy pre-B5, or web/program link with no
      // product). NOT a different-product visit — those are excluded by tier 1's filter.
      const generic = await pickVisit({ productId: null });
      if (generic) return generic;
      return null;
    }

    // No product context (caller can't supply one) → legacy behavior: latest visit of any product.
    return pickVisit({});
  }
}

export const attributionService = new AttributionService();
