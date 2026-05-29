import type { Response } from 'express';
import { ProfileService } from './profile.service';
import { prisma } from '@bb/db';
import { ok } from '@/common/utils/response.util';
import { UnauthorizedException } from '@/common/exceptions';
import { serializeMemberFull } from '@/modules/member/member.serializer';
import type { AuthenticatedRequest } from '@/common/interfaces/authenticated-request';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@/common/openapi/decorators';
import { MemberFullDto } from '@/common/openapi/member.dto';
import { MemberProfileDto } from './dto/profile.dto';

@ApiTags('Profile')
@ApiBearerAuth()
export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

  // Builds the FE ProfileModel-compat envelope shared by /profile/info and
  // /profile/location. Explicit field set — drops legacy aliases (imageUrl,
  // avatarUrl, biography, isVerified, dateRegister, etc.) so FE can retire
  // its `??` fallback chains. Canonical names per audit §3.1:
  // - image (drop imageUrl / memberImageUrl)
  // - bio (drop biography)
  // - phoneNumber / phoneCode (string, from Member.phone / Member.phoneCode)
  // - country/province/city/districtId (string IDs per audit §3.2)
  private async serializeProfileLegacy(memberId: string) {
    const member = await this.profileService.getInfo(memberId);

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
    return {
      // FE ProfileModel — canonical fields only
      memberId: member.legacyId ?? member.id,
      image: member.avatarUrl,
      name: member.fullName,
      phoneNumber: member.phone,
      phoneCode: member.phoneCode,
      firstName: member.firstName,
      lastName: member.lastName,
      postalCode: p?.postalCode ?? null,
      countryId: p?.country?.legacyId?.toString() ?? p?.countryId ?? null,
      countryName: p?.country?.name ?? null,
      provinceId: p?.province?.legacyId?.toString() ?? p?.provinceId ?? null,
      provinceName: p?.province?.name ?? null,
      cityId: p?.city?.legacyId?.toString() ?? p?.cityId ?? null,
      cityName: p?.city?.name ?? null,
      districtId: p?.district?.legacyId?.toString() ?? p?.districtId ?? null,
      districtName: p?.district?.name ?? null,
      bio: member.bio,
      address: p?.address ?? null,
      isPreRegister: 0,
      loginCount: 0,
      isDeleted: member.scheduledDeletionAt ? 1 : 0,
      affiliatorCode: member.affiliateCode ?? null,
      haveAffiliateConnect: member.inviterId !== null,
      affiliateConnectedData,
    };
  }

  @ApiOperation({ summary: 'Get my profile info' })
  @ApiResponse({ status: 200, type: () => MemberProfileDto })
  getInfo = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    return ok(res, await this.serializeProfileLegacy(req.user.id));
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
  @ApiResponse({ status: 200, type: () => MemberProfileDto })
  updateLocation = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const body = req.body ?? {};
    await this.profileService.updateLocation(req.user.id, {
      countryId: body.countryId,
      provinceId: body.provinceId,
      cityId: body.cityId,
      districtId: body.districtId,
      address: body.address,
      postalCode: body.postalCode,
    });
    // FE legacy parser expects ProfileModel — same shape as /profile/info.
    return ok(res, await this.serializeProfileLegacy(req.user.id));
  };
}
