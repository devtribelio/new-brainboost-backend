import type { Response } from 'express';
import { MemberService } from './member.service';
import { ok } from '@/common/utils/response.util';
import type { AuthenticatedRequest } from '@/common/interfaces/authenticated-request';
import { UnauthorizedException } from '@/common/exceptions';
import { serializeMemberFull } from '@/common/serializers';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@/common/openapi/decorators';

@ApiTags('Member')
@ApiBearerAuth()
export class MemberController {
  constructor(private readonly memberService: MemberService) {}

  @ApiOperation({ summary: 'Authenticated member info (with profile)' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 401, description: 'Missing/invalid bearer token' })
  info = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const member = await this.memberService.findById(req.user.id);
    const profile = member.profile
      ? {
          address: member.profile.address,
          postalCode: member.profile.postalCode,
          country: member.profile.country
            ? { id: member.profile.country.id, name: member.profile.country.name, legacyId: member.profile.country.legacyId }
            : null,
          province: member.profile.province
            ? { id: member.profile.province.id, name: member.profile.province.name, legacyId: member.profile.province.legacyId }
            : null,
          city: member.profile.city
            ? { id: member.profile.city.id, name: member.profile.city.name, legacyId: member.profile.city.legacyId }
            : null,
          district: member.profile.district
            ? { id: member.profile.district.id, name: member.profile.district.name, legacyId: member.profile.district.legacyId }
            : null,
        }
      : null;
    return ok(res, { ...serializeMemberFull(member), profile });
  };
}
