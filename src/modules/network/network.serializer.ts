import type { Network } from '@prisma/client';

export function serializeNetwork(
  n: Network & { members?: { memberId: string }[] } & Record<string, unknown>,
): Record<string, unknown> {
  return {
    networkId: n.legacyId ?? n.id,
    id: n.id,
    name: n.name,
    description: n.description,
    logoImageUrl: n.iconUrl,
    bannerImageUrl: n.bannerUrl,
    countMember: n.countMember,
    isPaid: n.isPaid,
    createdAt: n.createdAt,
  };
}

// FE NetworkMemberModel is flat — mix Member + Member.profile + joinedAt.
interface NetworkMemberRow {
  id: string;
  legacyId: number | null;
  email: string;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  bio: string | null;
  phone: string | null;
  gender: string | null;
  birthdate: Date | null;
  isVerified: boolean;
  isPhoneVerified: boolean;
  createdAt: Date;
  profile?: {
    address: string | null;
    postalCode: string | null;
    province?: { legacyId: number | null; name: string } | null;
    city?: { legacyId: number | null; name: string } | null;
  } | null;
}

export function serializeNetworkMemberLegacy(
  m: NetworkMemberRow,
  joinedAt: Date,
): Record<string, unknown> {
  const p = m.profile;
  return {
    memberId: m.legacyId ?? m.id,
    name: m.fullName ?? (`${m.firstName ?? ''} ${m.lastName ?? ''}`.trim() || null),
    provinceId: p?.province?.legacyId ?? null,
    provinceName: p?.province?.name ?? null,
    cityId: p?.city?.legacyId ?? null,
    cityName: p?.city?.name ?? null,
    email: m.email,
    phone: m.phone,
    gender: m.gender,
    isEmailVerified: m.isVerified ? 1 : 0,
    isPhoneVerified: m.isPhoneVerified ? 1 : 0,
    postalCode: p?.postalCode ?? null,
    imageUrl: m.avatarUrl,
    coverUrl: m.coverUrl,
    biography: m.bio,
    birthdate: m.birthdate ? m.birthdate.toISOString().slice(0, 10) : null,
    address: p?.address ?? null,
    dateRegister: joinedAt.toISOString(),
  };
}
