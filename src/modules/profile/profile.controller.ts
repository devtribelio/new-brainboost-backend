import type { Response } from 'express';
import { ProfileService } from './profile.service';
import { ok } from '@/common/utils/response.util';
import { UnauthorizedException } from '@/common/exceptions';
import { serializeMemberFull } from '@/common/serializers';
import type { AuthenticatedRequest } from '@/common/interfaces/authenticated-request';

export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

  getInfo = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const member = await this.profileService.getInfo(req.user.id);
    return ok(res, {
      ...serializeMemberFull(member),
      profile: member.profile,
    });
  };

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
