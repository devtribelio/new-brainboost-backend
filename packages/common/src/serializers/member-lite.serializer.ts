import type { Member } from '@prisma/client';

export interface MemberLite {
  id: string;
  legacyId: number | null;
  email: string;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  code: string | null;
}

export function serializeMember(m: Member | MemberLite): Record<string, unknown> {
  return {
    memberId: m.legacyId ?? m.id,
    id: m.id,
    code: (m as Member).code ?? null,
    email: m.email,
    name: m.fullName,
    firstName: m.firstName ?? null,
    lastName: m.lastName ?? null,
    imageUrl: m.avatarUrl,
    avatarUrl: m.avatarUrl,
  };
}
