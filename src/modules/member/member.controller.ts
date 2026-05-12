import type { Response } from 'express';
import { MemberService } from './member.service';
import { prisma } from '@/config/prisma';
import { env } from '@/config/env';
import { ok } from '@/common/utils/response.util';
import type { AuthenticatedRequest } from '@/common/interfaces/authenticated-request';
import { serializeMemberFull } from '@/common/serializers';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@/common/openapi/decorators';
import { ApiErrorResponseDto } from '@/common/openapi/common.dto';
import { MemberInfoDto } from './dto/member-info.dto';

function floatOrUndef(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : undefined;
}

@ApiTags('Member')
@ApiBearerAuth()
export class MemberController {
  constructor(private readonly memberService: MemberService) {}

  @ApiOperation({ summary: 'Authenticated member info (with profile + system config)' })
  @ApiQuery({ name: 'latitude', required: false, example: -6.9024 })
  @ApiQuery({ name: 'longitude', required: false, example: 107.6186 })
  @ApiResponse({ status: 200, type: () => MemberInfoDto })
  @ApiResponse({
    status: 401,
    description: 'Missing/invalid bearer token',
    type: () => ApiErrorResponseDto,
  })
  info = async (req: AuthenticatedRequest, res: Response) => {
    const communityNetworks = await prisma.network.findMany({
      where: { purpose: { in: ['timeline', 'education'] }, isActive: true },
      select: { id: true, legacyId: true, code: true, name: true, purpose: true },
    });
    const community = communityNetworks.map((n) => ({
      page: n.purpose,
      networkId: n.legacyId ?? n.id,
      networkCode: n.code ?? n.id,
      name: n.name,
    }));

    const base = {
      appName: process.env.APP_NAME ?? 'Brainboost',
      appCode: process.env.APP_CODE ?? 'brainboost',
      affiliatePlatformUrl: process.env.AFFILIATE_PLATFORM_URL ?? `${env.baseUrl}/affiliate`,
      maintenance: process.env.MAINTENANCE === 'true' ? 1 : 0,
      maintenanceMessage: process.env.MAINTENANCE_MESSAGE ?? null,
      maintenanceEndDateTime: process.env.MAINTENANCE_END ?? null,
      community,
    };

    // No token OR anon-scope token → return base info only (FE splash flow).
    if (!req.user || req.user.scope !== 'member') {
      return ok(res, base);
    }

    const result = await this.memberService.findById(req.user.id, {
      latitude: floatOrUndef(req.query.latitude),
      longitude: floatOrUndef(req.query.longitude),
      touchActivity: true,
    });
    const m = result.member;
    const profile = m.profile
      ? {
          address: m.profile.address,
          postalCode: m.profile.postalCode,
          country: m.profile.country
            ? { id: m.profile.country.id, name: m.profile.country.name, legacyId: m.profile.country.legacyId }
            : null,
          province: m.profile.province
            ? { id: m.profile.province.id, name: m.profile.province.name, legacyId: m.profile.province.legacyId }
            : null,
          city: m.profile.city
            ? { id: m.profile.city.id, name: m.profile.city.name, legacyId: m.profile.city.legacyId }
            : null,
          district: m.profile.district
            ? { id: m.profile.district.id, name: m.profile.district.name, legacyId: m.profile.district.legacyId }
            : null,
        }
      : null;

    return ok(res, {
      ...base,
      ...serializeMemberFull(m),
      profile,
      memberLogin: result.memberLogin,
      system: result.system,
    });
  };
}
