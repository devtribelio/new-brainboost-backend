import type { Request, Response } from 'express';
import type { AffiliateProgramService } from './program.service';
import type { AffiliatorService } from './affiliator.service';
import type { EnrollmentService } from './enrollment.service';
import type { DisbursementService } from './disbursement.service';
import { VisitService } from './visit.service';
import { ok, okCreated, okPaginated } from '@bb/common/utils/response.util';
import { UnauthorizedException, BadRequestException } from '@bb/common/exceptions';
import type { AuthenticatedRequest } from '@bb/common/interfaces/authenticated-request';
import type { AffiliateBased } from './constants';
import { AFFILIATE_COOKIE_NAME, AFFILIATE_COOKIE_DAYS_DEFAULT } from './constants';
import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@bb/common/openapi/decorators';
import { LogAttributionDto, LogVisitDto, SetModeDto } from './dto/affiliate-request.dto';
import {
  AffiliateCommissionDto,
  AffiliateDisbursementDto,
  AffiliateProgramDto,
  AffiliatorProfileDto,
  AffiliatorSummaryDto,
  DisbursementSummaryDto,
  MemberAffiliatorDto,
  SetModeResultDto,
  VisitLogResultDto,
} from './dto/affiliate-response.dto';

@ApiTags('Affiliate')
export class AffiliateController {
  constructor(
    private readonly programService: AffiliateProgramService,
    private readonly affiliatorService: AffiliatorService,
    private readonly enrollmentService: EnrollmentService,
    private readonly visitService: VisitService,
    private readonly disbursementService: DisbursementService,
  ) {}

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get my affiliator profile (auto-generates affiliateCode if missing)' })
  @ApiResponse({ status: 200, type: () => AffiliatorProfileDto })
  getMe = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const profile = await this.affiliatorService.getMe(req.user.id);
    return ok(res, profile);
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Set my affiliate mode (PERFORMANCE | GROWTH | INACTIVE)' })
  @ApiBody({ type: () => SetModeDto })
  @ApiResponse({ status: 200, type: () => SetModeResultDto })
  setMode = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const mode = (req.body?.mode as AffiliateBased) || (req.body?.affiliateBased as AffiliateBased);
    if (!mode) throw new BadRequestException('mode required');
    const updated = await this.affiliatorService.setMode(req.user.id, mode);
    return ok(res, updated);
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Affiliator dashboard summary (lifetime, balance, pending, current tier)' })
  @ApiResponse({ status: 200, type: () => AffiliatorSummaryDto })
  getSummary = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const summary = await this.affiliatorService.getSummary(req.user.id);
    return ok(res, summary);
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'List my commissions (paginated, optional status/from/to filter)' })
  @ApiQuery({ name: 'page', type: 'integer', required: false, example: 1 })
  @ApiQuery({ name: 'perPage', type: 'integer', required: false, example: 20, description: 'Max 100.' })
  @ApiQuery({ name: 'status', type: 'string', required: false, description: 'PENDING | BALANCE | VOIDED' })
  @ApiQuery({ name: 'from', type: 'string', required: false, description: 'ISO date — createdAt lower bound.' })
  @ApiQuery({ name: 'to', type: 'string', required: false, description: 'ISO date — createdAt upper bound.' })
  @ApiResponse({ status: 200, type: () => AffiliateCommissionDto, isArray: true, envelope: 'paginated' })
  listMyCommissions = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(100, Math.max(1, Number(req.query.perPage) || 20));
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const from = typeof req.query.from === 'string' ? new Date(req.query.from) : undefined;
    const to = typeof req.query.to === 'string' ? new Date(req.query.to) : undefined;
    const { rows, total } = await this.affiliatorService.listCommissions(req.user.id, { status, from, to }, page, perPage);
    return okPaginated(res, rows, { page, perPage, total });
  };

  @ApiOperation({ summary: 'List active affiliate programs' })
  @ApiResponse({ status: 200, type: () => AffiliateProgramDto, isArray: true })
  listPrograms = async (_req: Request, res: Response) => {
    const programs = await this.programService.listActive();
    return ok(res, programs);
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Enroll in a program by code' })
  @ApiResponse({ status: 201, type: () => MemberAffiliatorDto })
  enroll = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const code = req.params.code;
    if (!code) throw new BadRequestException('program code required');
    const enrollment = await this.enrollmentService.joinByCode(req.user.id, code);
    return okCreated(res, enrollment);
  };

  @ApiOperation({ summary: 'Log an affiliate link click. Always returns 200 — never breaks marketing ads.' })
  @ApiBody({ type: () => LogVisitDto })
  @ApiQuery({ name: 'program', type: 'string', required: false, description: 'Program code — query fallback for `programCode`.' })
  @ApiQuery({ name: 'affCode', type: 'string', required: false, description: 'Affiliator code — query fallback for `affiliatorCode`.' })
  @ApiResponse({ status: 200, type: () => VisitLogResultDto })
  logVisit = async (req: AuthenticatedRequest, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const programCode = (body.programCode || body.program_code || req.query.program) as string;
    const affiliatorCode = (body.affiliatorCode || body.affCode || body.aff || req.query.affCode) as string;

    const queryParsed = VisitService.parseQuery({ ...req.query, ...body });
    const result = await this.visitService.logVisit({
      programCode,
      affiliatorCode,
      memberId: req.user?.id ?? null,
      utmSource: queryParsed.utmSource ?? (body.utmSource as string | undefined),
      utmMedium: queryParsed.utmMedium ?? (body.utmMedium as string | undefined),
      utmCampaign: queryParsed.utmCampaign ?? (body.utmCampaign as string | undefined),
      utmContent: queryParsed.utmContent ?? (body.utmContent as string | undefined),
      utmTerm: queryParsed.utmTerm ?? (body.utmTerm as string | undefined),
      adId: queryParsed.adId ?? (body.adId as string | undefined),
      adNetwork: queryParsed.adNetwork ?? (body.adNetwork as string | undefined),
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
      referer: req.headers.referer,
      deviceId: (req.headers['x-device-id'] as string | undefined) ?? (body.deviceId as string | undefined),
      platform: (req.headers['x-platform'] as string | undefined) ?? (body.platform as string | undefined),
      appVersion: (req.headers['x-app-version'] as string | undefined) ?? (body.appVersion as string | undefined),
      installReferrer: body.installReferrer as string | undefined,
      rawQueryString: req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : undefined,
      rawHeaders: VisitService.sanitizeHeaders(req.headers as Record<string, string | string[] | undefined>),
      clientEventId: body.clientEventId as string | undefined,
    });

    // Legacy parity: drop a last-touch attribution cookie (web flow). Latest click wins
    // (sticky until overwritten/expired). Apps ignore this and pass affiliateCode explicitly.
    // Duration is runtime-configurable via app_settings (affiliate.cookieDays).
    if (affiliatorCode) {
      const cookieDays = await settingsService.getNumber(
        SETTING_KEYS.affiliateCookieDays,
        AFFILIATE_COOKIE_DAYS_DEFAULT,
      );
      res.cookie(AFFILIATE_COOKIE_NAME, affiliatorCode, {
        maxAge: cookieDays * 24 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production',
      });
    }

    return ok(res, result);
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Bind affiliate attribution to logged-in member (deep-link post-login)' })
  @ApiBody({ type: () => LogAttributionDto })
  @ApiResponse({ status: 200, type: () => VisitLogResultDto })
  logAttribution = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const programCode = (body.programCode || body.program_code) as string;
    const affiliatorCode = (body.affiliatorCode || body.affCode || body.aff) as string;
    if (!programCode || !affiliatorCode) {
      throw new BadRequestException('programCode and affiliatorCode required');
    }

    const result = await this.visitService.logAttribution({
      programCode,
      affiliatorCode,
      memberId: req.user.id,
      utmSource: body.utmSource as string | undefined,
      utmMedium: body.utmMedium as string | undefined,
      utmCampaign: body.utmCampaign as string | undefined,
      utmContent: body.utmContent as string | undefined,
      utmTerm: body.utmTerm as string | undefined,
      adId: body.adId as string | undefined,
      adNetwork: body.adNetwork as string | undefined,
      deviceId: (req.headers['x-device-id'] as string | undefined) ?? (body.deviceId as string | undefined),
      platform: (req.headers['x-platform'] as string | undefined) ?? (body.platform as string | undefined),
      appVersion: (req.headers['x-app-version'] as string | undefined) ?? (body.appVersion as string | undefined),
      installReferrer: body.installReferrer as string | undefined,
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
      clientEventId: body.clientEventId as string | undefined,
    });

    return ok(res, result);
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Withdrawable balance + payout eligibility' })
  @ApiResponse({ status: 200, type: () => DisbursementSummaryDto })
  getDisbursementSummary = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const summary = await this.disbursementService.getSummary(req.user.id);
    return ok(res, summary);
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Request a payout for the full withdrawable balance' })
  @ApiResponse({ status: 201, type: () => AffiliateDisbursementDto })
  requestDisbursement = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const disbursement = await this.disbursementService.requestDisbursement(req.user.id);
    return okCreated(res, disbursement);
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'List my payout requests (paginated)' })
  @ApiQuery({ name: 'page', type: 'integer', required: false, example: 1 })
  @ApiQuery({ name: 'perPage', type: 'integer', required: false, example: 20, description: 'Max 100.' })
  @ApiResponse({ status: 200, type: () => AffiliateDisbursementDto, isArray: true, envelope: 'paginated' })
  listDisbursements = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(100, Math.max(1, Number(req.query.perPage) || 20));
    const { rows, total } = await this.disbursementService.listDisbursements(req.user.id, page, perPage);
    return okPaginated(res, rows, { page, perPage, total });
  };
}

function extractIp(req: Request): string | undefined {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0]?.trim();
  return req.socket.remoteAddress ?? undefined;
}
