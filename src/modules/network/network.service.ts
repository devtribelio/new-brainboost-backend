import { prisma } from '@/config/prisma';
import { BadRequestException, NotFoundException } from '@/common/exceptions';
import type { PaginationParams } from '@/common/utils/pagination.util';

export class NetworkService {
  private async resolveNetworkId(input: string): Promise<string | null> {
    const legacyId = Number.parseInt(input, 10);
    if (Number.isFinite(legacyId) && input === String(legacyId)) {
      const byLegacy = await prisma.network.findUnique({
        where: { legacyId },
        select: { id: true },
      });
      if (byLegacy) return byLegacy.id;
    }
    const byId = await prisma.network.findUnique({ where: { id: input }, select: { id: true } });
    return byId?.id ?? null;
  }

  async listMembers(p: PaginationParams, networkInput: string) {
    const networkId = await this.resolveNetworkId(networkInput);
    if (!networkId) return { rows: [], total: 0 };
    const [rows, total] = await Promise.all([
      prisma.networkMember.findMany({
        where: { networkId },
        orderBy: { joinedAt: 'desc' },
        skip: p.skip,
        take: p.take,
      }),
      prisma.networkMember.count({ where: { networkId } }),
    ]);

    const memberIds = rows.map((r) => r.memberId);
    const members = memberIds.length
      ? await prisma.member.findMany({
          where: { id: { in: memberIds } },
          select: {
            id: true,
            legacyId: true,
            email: true,
            fullName: true,
            firstName: true,
            lastName: true,
            avatarUrl: true,
            code: true,
          },
        })
      : [];
    const memberMap = new Map(members.map((m) => [m.id, m]));
    const enriched = rows
      .map((r) => {
        const m = memberMap.get(r.memberId);
        return m ? { networkMember: r, member: m } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return { rows: enriched, total };
  }

  async listTags(p: PaginationParams, networkInput: string) {
    const networkId = await this.resolveNetworkId(networkInput);
    if (!networkId) return { rows: [], total: 0 };
    const [rows, total] = await Promise.all([
      prisma.networkTag.findMany({
        where: { networkId },
        orderBy: { name: 'asc' },
        skip: p.skip,
        take: p.take,
      }),
      prisma.networkTag.count({ where: { networkId } }),
    ]);
    return { rows, total };
  }

  async join(memberId: string, networkInput: string) {
    const networkId = await this.resolveNetworkId(networkInput);
    if (!networkId) throw new NotFoundException('Network not found');

    const existing = await prisma.networkMember.findUnique({
      where: { networkId_memberId: { networkId, memberId } },
    });
    if (existing) return { networkId, alreadyJoined: true };

    await prisma.$transaction([
      prisma.networkMember.create({ data: { networkId, memberId } }),
      prisma.network.update({
        where: { id: networkId },
        data: { countMember: { increment: 1 } },
      }),
    ]);
    return { networkId, joined: true };
  }

  async leave(memberId: string, networkInput: string) {
    const networkId = await this.resolveNetworkId(networkInput);
    if (!networkId) throw new BadRequestException('Network not found');
    const existing = await prisma.networkMember.findUnique({
      where: { networkId_memberId: { networkId, memberId } },
    });
    if (!existing) return { networkId, alreadyLeft: true };
    await prisma.$transaction([
      prisma.networkMember.delete({ where: { id: existing.id } }),
      prisma.network.update({
        where: { id: networkId },
        data: { countMember: { decrement: 1 } },
      }),
    ]);
    return { networkId, left: true };
  }
}
