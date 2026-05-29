import { prisma } from '@bb/db';
import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import { AFFILIATE_COOKIE_DAYS_DEFAULT } from './constants';

/**
 * Resolves the per-purchase commission "override" affiliator (last-touch), shared by web
 * checkout and 3rd-party ingestion so attribution is consistent across channels.
 *
 * Precedence:
 *   1. explicit affiliate code for THIS purchase (web cookie / app deeplink param / provider metadata)
 *   2. most-recent AffiliateVisit within the configurable window (app_settings: affiliate.cookieDays)
 *   3. null → engine then falls back to the buyer's permanent inviterId
 */
export class AttributionService {
  async resolveOverrideAffiliatorMemberId(
    buyerMemberId: string,
    explicitCode?: string | null,
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
    const visit = await prisma.affiliateVisit.findFirst({
      where: { memberId: buyerMemberId, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      select: { affiliatorMemberId: true },
    });
    if (visit && visit.affiliatorMemberId !== buyerMemberId) return visit.affiliatorMemberId;

    return null;
  }
}

export const attributionService = new AttributionService();
