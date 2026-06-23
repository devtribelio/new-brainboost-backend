import { prisma } from '@bb/db';

export class RecipientResolver {
  async resolveForNetwork(networkId: string, excludeMemberId?: string): Promise<string[]> {
    const rows = await prisma.networkMember.findMany({
      where: {
        networkId,
        ...(excludeMemberId ? { memberId: { not: excludeMemberId } } : {}),
      },
      select: { memberId: true },
    });
    return this.filterEnabled(rows.map((r) => r.memberId));
  }

  async resolveSingle(memberId: string): Promise<string | null> {
    const m = await prisma.member.findUnique({
      where: { id: memberId },
      select: { notificationsEnabled: true, isActive: true },
    });
    if (!m || !m.isActive || !m.notificationsEnabled) return null;
    return memberId;
  }

  async filterEnabled(memberIds: string[]): Promise<string[]> {
    if (memberIds.length === 0) return [];
    const rows = await prisma.member.findMany({
      where: { id: { in: memberIds }, notificationsEnabled: true, isActive: true },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  async filterNotMuted(memberIds: string[], scopes: Array<{ scope: string; refId: string }>): Promise<string[]> {
    if (memberIds.length === 0 || scopes.length === 0) return memberIds;
    const muted = await prisma.notificationMute.findMany({
      where: {
        memberId: { in: memberIds },
        OR: scopes.map((s) => ({ scope: s.scope, refId: s.refId })),
      },
      select: { memberId: true },
    });
    const mutedSet = new Set(muted.map((m) => m.memberId));
    return memberIds.filter((id) => !mutedSet.has(id));
  }
}
