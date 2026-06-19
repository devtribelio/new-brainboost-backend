import type { Member } from '@prisma/client';

export interface MemberLite {
  id: string;
  legacyId: number | null;
  email: string;
  fullName: string | null;
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
    imageUrl: m.avatarUrl,
    avatarUrl: m.avatarUrl,
  };
}
