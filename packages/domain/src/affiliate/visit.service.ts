import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';

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
   * Create an AffiliateVisit from the registration flow when attribution
   * context was captured at pre-registration and carried forward to register.
   *
   * Differs from logVisit: callers already hold resolved IDs (no code→ID
   * translation needed). Also handles the §3.5 fallback: when programCode is
   * absent but affiliatorMemberId is set, auto-picks the program if the
   * affiliator is enrolled in exactly one active program.
   *
   * Returns status: 'logged' | 'skipped' | 'error'. Never throws.
   */
  async createVisitFromRegistration(input: {
    memberId: string;
    affiliatorMemberId: string;
    programCode?: string;
    utmSource?: string;
    utmMedium?: string;
    utmCampaign?: string;
    utmContent?: string;
    utmTerm?: string;
    adId?: string;
    adNetwork?: string;
    installReferrer?: string;
    deviceId?: string;
    platform?: string;
    appVersion?: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<{ status: 'logged' | 'skipped' | 'error'; visitId?: string; reason?: string }> {
    try {
      let programId: string | null = null;

      if (input.programCode) {
        const program = await prisma.affiliateProgram.findUnique({
          where: { code: input.programCode },
          select: { id: true },
        });
        if (!program) {
          logger.info(
            { programCode: input.programCode, affiliatorMemberId: input.affiliatorMemberId },
            'affiliate.visit.registration.unknown_program_code — skipping visit creation',
          );
          return { status: 'skipped', reason: 'unknown programCode' };
        }
        programId = program.id;
      } else {
        // §3.5 fallback: auto-pick if the affiliator is enrolled in exactly 1 active program.
        const enrollments = await prisma.memberAffiliator.findMany({
          where: { memberId: input.affiliatorMemberId, isActive: true },
          select: { programId: true },
        });
        if (enrollments.length === 1) {
          programId = enrollments[0]!.programId;
          logger.info(
            { affiliatorMemberId: input.affiliatorMemberId, programId },
            'affiliate.visit.registration.fallback_single_program',
          );
        } else {
          logger.info(
            {
              affiliatorMemberId: input.affiliatorMemberId,
              enrollmentCount: enrollments.length,
            },
            'affiliate.visit.registration.ambiguous_program — skipping visit creation',
          );
          return {
            status: 'skipped',
            reason: `ambiguous: affiliator enrolled in ${enrollments.length} programs`,
          };
        }
      }

      const visit = await prisma.affiliateVisit.create({
        data: {
          programId,
          affiliatorMemberId: input.affiliatorMemberId,
          memberId: input.memberId,
          utmSource: input.utmSource,
          utmMedium: input.utmMedium,
          utmCampaign: input.utmCampaign,
          utmContent: input.utmContent,
          utmTerm: input.utmTerm,
          adId: input.adId,
          adNetwork: input.adNetwork,
          installReferrer: input.installReferrer,
          deviceId: input.deviceId,
          platform: input.platform,
          appVersion: input.appVersion,
          ipAddress: input.ipAddress ?? undefined,
          userAgent: input.userAgent ?? undefined,
        },
      });

      logger.info(
        { visitId: visit.id, memberId: input.memberId, programId },
        'affiliate.visit.registration.logged',
      );
      return { status: 'logged', visitId: visit.id };
    } catch (err) {
      logger.error({ err, input }, 'affiliate.visit.registration.write_failed');
      return { status: 'error', reason: 'internal' };
    }
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
