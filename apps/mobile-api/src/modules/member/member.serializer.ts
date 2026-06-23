import type { Member } from '@prisma/client';
import { serializeMember } from '@bb/common/serializers/member-lite.serializer';

/**
 * Full member shape — legacy NetworkMember/Member fields used by mobile.
 * Mobile `NetworkMemberModel` expects: memberId, name, provinceId/Name,
 * cityId/Name, email, phone, gender, isEmailVerified, isPhoneVerified,
 * postalCode, imageUrl, coverUrl, biography, birthdate, address, dateRegister.
 */
export function serializeMemberFull(m: Member): Record<string, unknown> {
  return {
    ...serializeMember(m),
    phone: m.phone,
    phoneCode: m.phoneCode,
    coverUrl: m.coverUrl,
    bio: m.bio,
    biography: m.bio, // legacy alias
    gender: m.gender,
    birthdate: m.birthdate,
    isActive: m.isActive,
    isVerified: m.isEmailVerified, // legacy alias (FE pre-rename)
    isEmailVerified: m.isEmailVerified,
    isPhoneVerified: m.isPhoneVerified,
    dateRegister: m.createdAt, // legacy alias
    createdAt: m.createdAt,
  };
}
