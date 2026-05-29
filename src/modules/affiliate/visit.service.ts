import { prisma } from '@bb/db';
import { logger } from '@/config/logger';
import { COOKIE_DAYS } from './constants';

export interface VisitInput {
  programCode: string;
  affiliatorCode: string;
  memberId?: string | null;
  // marketing
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  adId?: string;
  adNetwork?: string;
  // device
  ipAddress?: string;
  userAgent?: string;
  referer?: string;
  deviceId?: string;
  platform?: string;
  appVersion?: string;
  installReferrer?: string;
  // raw escape-hatch
  rawQueryString?: string;
  rawHeaders?: Record<string, string>;
  // idempotency
  clientEventId?: string;
}

export interface VisitLogResult {
  status: 'logged' | 'duplicate' | 'invalid' | 'error';
  visitId?: string;
  reason?: string;
}

const ALLOWED_HEADER_NAMES = new Set([
  'user-agent',
  'referer',
  'accept-language',
  'x-forwarded-for',
  'x-real-ip',
  'cf-connecting-ip',
  'cf-ipcountry',
  'x-device-id',
  'x-platform',
  'x-app-version',
]);

export class VisitService {
  /**
   * Log a visit event. Critical: never throws — marketing ad links cannot
   * silently 4xx/5xx. Always returns a status object; caller responds 200
   * regardless of internal outcome.
   */
  async logVisit(input: VisitInput): Promise<VisitLogResult> {
    try {
      if (!input.programCode || !input.affiliatorCode) {
        logger.warn({ input }, 'affiliate.visit.invalid_payload');
        return { status: 'invalid', reason: 'programCode and affiliatorCode required' };
      }

      const [program, affiliator] = await Promise.all([
        prisma.affiliateProgram.findUnique({ where: { code: input.programCode } }),
        prisma.member.findUnique({ where: { affiliateCode: input.affiliatorCode } }),
      ]);

      if (!program) {
        logger.warn({ code: input.programCode }, 'affiliate.visit.unknown_program');
        return { status: 'invalid', reason: 'unknown program' };
      }
      if (!affiliator) {
        logger.warn({ code: input.affiliatorCode }, 'affiliate.visit.unknown_affiliator');
        return { status: 'invalid', reason: 'unknown affiliator' };
      }

      // Idempotency check via clientEventId
      if (input.clientEventId) {
        const existing = await prisma.affiliateVisit.findUnique({
          where: { clientEventId: input.clientEventId },
        });
        if (existing) {
          return { status: 'duplicate', visitId: existing.id };
        }
      }

      const visit = await prisma.affiliateVisit.create({
        data: {
          programId: program.id,
          affiliatorMemberId: affiliator.id,
          memberId: input.memberId ?? null,
          utmSource: input.utmSource,
          utmMedium: input.utmMedium,
          utmCampaign: input.utmCampaign,
          utmContent: input.utmContent,
          utmTerm: input.utmTerm,
          adId: input.adId,
          adNetwork: input.adNetwork,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
          referer: input.referer,
          deviceId: input.deviceId,
          platform: input.platform,
          appVersion: input.appVersion,
          installReferrer: input.installReferrer,
          rawQueryString: input.rawQueryString,
          rawHeaders: input.rawHeaders ? JSON.parse(JSON.stringify(input.rawHeaders)) : undefined,
          clientEventId: input.clientEventId,
        },
      });

      return { status: 'logged', visitId: visit.id };
    } catch (err) {
      // Last-resort catch — log but never propagate
      logger.error({ err, input }, 'affiliate.visit.write_failed');
      return { status: 'error', reason: 'internal' };
    }
  }

  /**
   * Re-log a visit after login to bind attribution to a member.
   * App calls this after deep-link → login flow with stored affiliator/program code.
   */
  async logAttribution(input: VisitInput & { memberId: string }): Promise<VisitLogResult> {
    return this.logVisit({ ...input, memberId: input.memberId });
  }

  /**
   * Find latest non-expired visit for (memberId, programId) — used at
   * commission generation time. Returns null if no active attribution.
   */
  async findActiveAttribution(memberId: string, programId: string) {
    const cutoff = new Date(Date.now() - COOKIE_DAYS * 86_400_000);
    return prisma.affiliateVisit.findFirst({
      where: {
        memberId,
        programId,
        createdAt: { gt: cutoff },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Sanitize request headers to allowlisted set + JSON-safe shape.
   */
  static sanitizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      const lower = key.toLowerCase();
      if (!ALLOWED_HEADER_NAMES.has(lower)) continue;
      if (value === undefined) continue;
      out[lower] = Array.isArray(value) ? value.join(', ') : value;
    }
    return out;
  }

  /**
   * Parse marketing params from query string into VisitInput shape.
   */
  static parseQuery(query: Record<string, unknown>): Partial<VisitInput> {
    const s = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
    const adId = s(query.gclid) ?? s(query.fbclid) ?? s(query.ttclid) ?? s(query.bb_ad_id);
    const adNetwork = s(query.gclid) ? 'google' : s(query.fbclid) ? 'meta' : s(query.ttclid) ? 'tiktok' : undefined;
    return {
      utmSource: s(query.utm_source),
      utmMedium: s(query.utm_medium),
      utmCampaign: s(query.utm_campaign),
      utmContent: s(query.utm_content),
      utmTerm: s(query.utm_term),
      adId,
      adNetwork,
    };
  }
}
