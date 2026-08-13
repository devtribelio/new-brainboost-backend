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

  // Raw (unfiltered) subscriber ids. Unlike resolveForNetwork this deliberately
  // skips filterEnabled: a topic fan-out is unbounded, so the caller slices the
  // list and filters per chunk instead of loading every member row at once.
  async subscriberIdsForTopic(topicId: string, excludeMemberId?: string): Promise<string[]> {
    const rows = await prisma.topicSubscription.findMany({
      where: {
        topicId,
        ...(excludeMemberId ? { memberId: { not: excludeMemberId } } : {}),
      },
      select: { memberId: true },
    });
    return rows.map((r) => r.memberId);
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

  // Which of these members silenced at least one of the scopes. Deliberately
  // NOT a "filterNotMuted" that drops them from the recipient list: a mute
  // silences the push only — the notification row is still written, so the
  // member finds it in their history when they open the app. The producer is
  // the sole consumer; listeners must not use this to skip recipients.
  async mutedMemberIds(
    memberIds: string[],
    scopes: Array<{ scope: string; refId: string }>,
  ): Promise<Set<string>> {
    if (memberIds.length === 0 || scopes.length === 0) return new Set();
    const muted = await prisma.notificationMute.findMany({
      where: {
        memberId: { in: memberIds },
        OR: scopes.map((s) => ({ scope: s.scope, refId: s.refId })),
      },
      select: { memberId: true },
    });
    return new Set(muted.map((m) => m.memberId));
  }
}
