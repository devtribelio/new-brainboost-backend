import type { Response } from 'express';
import { ProfileService } from './profile.service';
import { prisma } from '@/config/prisma';
import { ok } from '@/common/utils/response.util';
import { UnauthorizedException } from '@/common/exceptions';
import { serializeMemberFull } from '@/common/serializers';
import type { AuthenticatedRequest } from '@/common/interfaces/authenticated-request';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@/common/openapi/decorators';
import { MemberFullDto } from '@/common/openapi/member.dto';
import { MemberLocationDto, MemberProfileDto } from './dto/profile.dto';

@ApiTags('Profile')
@ApiBearerAuth()
export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

  @ApiOperation({ summary: 'Get my profile info' })
  @ApiResponse({ status: 200, type: () => MemberProfileDto })
  getInfo = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const member = await this.profileService.getInfo(req.user.id);

    // Resolve inviter (affiliate connection) for ProfileModel-compat shape
    let affiliateConnectedData: Record<string, unknown> | null = null;
    if (member.inviterId) {
      const inviter = await prisma.member.findUnique({
        where: { id: member.inviterId },
        select: { id: true, legacyId: true, affiliateCode: true },
      });
      if (inviter) {
        affiliateConnectedData = {
          memberNetworkConnectId: null,
          memberId: member.legacyId ?? member.id,
          affiliatorCode: inviter.affiliateCode ?? null,
          affiliatorMemberId: inviter.legacyId ?? inviter.id,
        };
      }
    }

    const p = member.profile;
    return ok(res, {
      ...serializeMemberFull(member),
      // ProfileModel-compat fields (mobile account_remote_source.profileInfo())
      image: member.avatarUrl,
      phoneNumber: member.phone,
      phoneCode: member.phoneCode,
      address: p?.address ?? null,
      postalCode: p?.postalCode ?? null,
      countryId: p?.country?.legacyId?.toString() ?? p?.countryId ?? null,
      countryName: p?.country?.name ?? null,
      provinceId: p?.province?.legacyId?.toString() ?? p?.provinceId ?? null,
      provinceName: p?.province?.name ?? null,
      cityId: p?.city?.legacyId?.toString() ?? p?.cityId ?? null,
      cityName: p?.city?.name ?? null,
      districtId: p?.district?.legacyId?.toString() ?? p?.districtId ?? null,
      districtName: p?.district?.name ?? null,
      isPreRegister: 0,
      loginCount: 0,
      isDeleted: member.scheduledDeletionAt ? 1 : 0,
      affiliatorCode: member.affiliateCode ?? null,
      haveAffiliateConnect: member.inviterId !== null,
      affiliateConnectedData,
      // legacy raw nested profile (extra, ignored by mobile parser)
      profile: member.profile,
    });
  };

  @ApiOperation({ summary: 'Update my profile fields' })
  @ApiResponse({ status: 200, type: () => MemberFullDto })
  update = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const body = req.body ?? {};
    const member = await this.profileService.updateInfo(req.user.id, {
      fullName: body.name ?? body.fullName,
      firstName: body.firstName,
      lastName: body.lastName,
      phone: body.phone,
      phoneCode: body.phoneCode,
      bio: body.biography ?? body.bio,
      avatarUrl: body.imageUrl ?? body.avatarUrl,
      coverUrl: body.coverImageUrl ?? body.coverUrl,
    });
    return ok(res, serializeMemberFull(member));
  };

  @ApiOperation({ summary: 'Set my address / location FK chain' })
  @ApiResponse({ status: 200, type: () => MemberLocationDto })
  updateLocation = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const body = req.body ?? {};
    const profile = await this.profileService.updateLocation(req.user.id, {
      countryId: body.countryId,
      provinceId: body.provinceId,
      cityId: body.cityId,
      districtId: body.districtId,
      address: body.address,
      postalCode: body.postalCode,
    });
    return ok(res, profile);
  };
}
