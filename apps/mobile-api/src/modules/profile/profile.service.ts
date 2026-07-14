import { isEmail } from 'class-validator';
import { prisma } from '@bb/db';
import { BadRequestException, NotFoundException } from '@bb/common/exceptions';
import { assertUuid } from '@bb/common/utils/uuid.util';
import { normalizePhonePair } from '@bb/common/utils/phone.util';

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
    if (!member.isActive) throw new NotFoundException('Member is not active');
    return member;
  }

  async updateInfo(memberId: string, dto: {
    fullName?: string;
    email?: string | null;
    phone?: string;
    phoneCode?: string;
    gender?: string;
    birthdate?: string;
    bio?: string;
    avatarUrl?: string;
    coverUrl?: string;
  }) {
    const member = await prisma.member.findUnique({ where: { id: memberId } });
    if (!member) throw new NotFoundException('Member not found');
    if (!member.isActive) throw new NotFoundException('Member is not active');

    if (dto.fullName !== undefined && (dto.fullName.trim().length < 4 || dto.fullName.length > 100)) {
      throw new BadRequestException('fullName must be 4-100 chars');
    }

    if (dto.gender !== undefined && !['MAN', 'WOMEN'].includes(dto.gender)) {
      throw new BadRequestException('gender must be MAN or WOMEN');
    }

    let birthdate: Date | null | undefined;
    if (dto.birthdate !== undefined) {
      if (dto.birthdate === null || dto.birthdate === '') {
        birthdate = null;
      } else {
        birthdate = new Date(dto.birthdate);
        if (Number.isNaN(birthdate.getTime())) throw new BadRequestException('Invalid birthdate');
        const ageYears = (Date.now() - birthdate.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
        if (ageYears < 13) throw new BadRequestException('Member must be at least 13 years old');
      }
    }

    // Email is changeable only while unverified; once verified
    // (auth/requestVerify type=email) it is locked — silently ignored here.
    let email: string | undefined;
    if (dto.email && !member.isEmailVerified) {
      const normalized = dto.email.trim().toLowerCase();
      if (!isEmail(normalized)) throw new BadRequestException('Invalid email');
      if (normalized !== member.email) {
        const emailTaken = await prisma.member.findFirst({
          where: { email: normalized, NOT: { id: memberId } },
          select: { id: true },
        });
        if (emailTaken) throw new BadRequestException('Email already used by another member');
        email = normalized;
      }
    }

    let phone = dto.phone;
    let phoneCode = dto.phoneCode;
    let phoneChanged = false;
    if (dto.phone) {
      if (!/^\+?[0-9]{6,20}$/.test(dto.phone)) {
        throw new BadRequestException('phone must be 6-20 digits, optional leading +');
      }
      // Same canonical forms as register/login — dedup catches format variants.
      const pair = normalizePhonePair(dto.phone, dto.phoneCode ?? member.phoneCode ?? '+62');
      if (pair.phone.length < 6) throw new BadRequestException('Invalid phone number');
      phone = pair.phone;
      phoneCode = pair.phoneCode;
      phoneChanged = pair.phone !== member.phone;
      const phoneTaken = await prisma.member.findFirst({
        where: { phone: pair.phone, NOT: { id: memberId } },
        select: { id: true },
      });
      if (phoneTaken) throw new BadRequestException('Phone already used by another member');
    }

    return prisma.member.update({
      where: { id: memberId },
      data: {
        fullName: dto.fullName,
        ...(email !== undefined ? { email } : {}),
        phone,
        phoneCode,
        // A new number was never OTP'd — verified status must not carry over.
        ...(phoneChanged ? { isPhoneVerified: false } : {}),
        gender: dto.gender,
        ...(birthdate !== undefined ? { birthdate } : {}),
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
    assertUuid(input);
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
    assertUuid(input);
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
    assertUuid(input);
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
    assertUuid(input);
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
