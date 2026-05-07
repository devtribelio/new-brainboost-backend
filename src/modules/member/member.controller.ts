import type { Response } from 'express';
import { MemberService } from './member.service';
import { ok } from '@/common/utils/response.util';
import type { AuthenticatedRequest } from '@/common/interfaces/authenticated-request';
import { UnauthorizedException } from '@/common/exceptions';
import { serializeMemberFull } from '@/common/serializers';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@/common/openapi/decorators';

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
  @ApiQuery({ name: 'latitude', required: false })
  @ApiQuery({ name: 'longitude', required: false })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 401, description: 'Missing/invalid bearer token' })
  info = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
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
      ...serializeMemberFull(m),
      profile,
      memberLogin: result.memberLogin,
      system: result.system,
    });
  };
}
