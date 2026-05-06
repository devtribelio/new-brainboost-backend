import { prisma } from '@/config/prisma';
import { NotFoundException } from '@/common/exceptions';

export class ProfileService {
  async getInfo(memberId: string) {
    const member = await prisma.member.findUnique({
      where: { id: memberId },
      include: {
        profile: {
          include: { country: true, province: true, city: true, district: true },
        },
      },
    });
    if (!member) throw new NotFoundException('Member not found');
    return member;
  }

  async updateInfo(memberId: string, dto: {
    fullName?: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
    phoneCode?: string;
    bio?: string;
    avatarUrl?: string;
    coverUrl?: string;
  }) {
    return prisma.member.update({
      where: { id: memberId },
      data: {
        fullName: dto.fullName,
        firstName: dto.firstName,
        lastName: dto.lastName,
        phone: dto.phone,
        phoneCode: dto.phoneCode,
        bio: dto.bio,
        avatarUrl: dto.avatarUrl,
        coverUrl: dto.coverUrl,
      },
    });
  }

  private async resolveCountry(input: string | undefined): Promise<string | null> {
    if (!input) return null;
    const legacyId = Number.parseInt(input, 10);
    if (Number.isFinite(legacyId) && input === String(legacyId)) {
      const r = await prisma.country.findUnique({ where: { legacyId }, select: { id: true } });
      if (r) return r.id;
    }
    const r = await prisma.country.findUnique({ where: { id: input }, select: { id: true } });
    return r?.id ?? null;
  }

  private async resolveProvince(input: string | undefined): Promise<string | null> {
    if (!input) return null;
    const legacyId = Number.parseInt(input, 10);
    if (Number.isFinite(legacyId) && input === String(legacyId)) {
      const r = await prisma.province.findUnique({ where: { legacyId }, select: { id: true } });
      if (r) return r.id;
    }
    const r = await prisma.province.findUnique({ where: { id: input }, select: { id: true } });
    return r?.id ?? null;
  }

  private async resolveCity(input: string | undefined): Promise<string | null> {
    if (!input) return null;
    const legacyId = Number.parseInt(input, 10);
    if (Number.isFinite(legacyId) && input === String(legacyId)) {
      const r = await prisma.city.findUnique({ where: { legacyId }, select: { id: true } });
      if (r) return r.id;
    }
    const r = await prisma.city.findUnique({ where: { id: input }, select: { id: true } });
    return r?.id ?? null;
  }

  private async resolveDistrict(input: string | undefined): Promise<string | null> {
    if (!input) return null;
    const legacyId = Number.parseInt(input, 10);
    if (Number.isFinite(legacyId) && input === String(legacyId)) {
      const r = await prisma.district.findUnique({ where: { legacyId }, select: { id: true } });
      if (r) return r.id;
    }
    const r = await prisma.district.findUnique({ where: { id: input }, select: { id: true } });
    return r?.id ?? null;
  }

  async updateLocation(memberId: string, dto: {
    countryId?: string;
    provinceId?: string;
    cityId?: string;
    districtId?: string;
    address?: string;
    postalCode?: string;
  }) {
    const countryId = await this.resolveCountry(dto.countryId);
    const provinceId = await this.resolveProvince(dto.provinceId);
    const cityId = await this.resolveCity(dto.cityId);
    const districtId = await this.resolveDistrict(dto.districtId);

    return prisma.memberProfile.upsert({
      where: { memberId },
      create: {
        memberId,
        countryId,
        provinceId,
        cityId,
        districtId,
        address: dto.address ?? null,
        postalCode: dto.postalCode ?? null,
      },
      update: {
        countryId,
        provinceId,
        cityId,
        districtId,
        address: dto.address,
        postalCode: dto.postalCode,
      },
    });
  }
}
