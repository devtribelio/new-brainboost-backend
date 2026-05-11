import { Prisma } from '@prisma/client';
import { prisma } from '@/config/prisma';
import { BadRequestException, ForbiddenException, NotFoundException } from '@/common/exceptions';
import type { PaginationParams } from '@/common/utils/pagination.util';

export class NetworkService {
  private async resolveNetworkId(input: string): Promise<string | null> {
    if (!input) return null;
    // Try by `code` first (mobile sends 8-char alphanumeric code from /info)
    const byCode = await prisma.network.findUnique({ where: { code: input }, select: { id: true } });
    if (byCode) return byCode.id;
    // Try legacyId numeric
    const legacyId = Number.parseInt(input, 10);
    if (Number.isFinite(legacyId) && input === String(legacyId)) {
      const byLegacy = await prisma.network.findUnique({
        where: { legacyId },
        select: { id: true },
      });
      if (byLegacy) return byLegacy.id;
    }
    // Try uuid
    const byId = await prisma.network.findUnique({ where: { id: input }, select: { id: true } });
    return byId?.id ?? null;
  }

  async listMembers(p: PaginationParams, networkInput: string) {
    const where: Prisma.NetworkMemberWhereInput = {};
    if (networkInput) {
      const networkId = await this.resolveNetworkId(networkInput);
      if (!networkId) return { rows: [], total: 0 };
      where.networkId = networkId;
    }
    const [rows, total] = await Promise.all([
      prisma.networkMember.findMany({
        where,
        orderBy: { joinedAt: 'desc' },
        skip: p.skip,
        take: p.take,
      }),
      prisma.networkMember.count({ where }),
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

  async listTags(
    p: PaginationParams,
    networkInput: string,
    keyword?: string,
  ) {
    const where: Prisma.NetworkTagWhereInput = {};
    if (networkInput) {
      const networkId = await this.resolveNetworkId(networkInput);
      if (!networkId) return { rows: [], total: 0 };
      where.networkId = networkId;
    }
    if (keyword) {
      where.name = { contains: keyword, mode: 'insensitive' };
    }
    const [rows, total] = await Promise.all([
      prisma.networkTag.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: p.skip,
        take: p.take,
      }),
      prisma.networkTag.count({ where }),
    ]);
    return { rows, total };
  }

  async join(memberId: string, networkInput: string) {
    const member = await prisma.member.findUnique({ where: { id: memberId } });
    if (!member) throw new NotFoundException('Member not found');
    if (!member.isActive) throw new ForbiddenException('Member is not active');

    const networkId = await this.resolveNetworkId(networkInput);
    if (!networkId) throw new NotFoundException('Network not found');

    const network = await prisma.network.findUnique({ where: { id: networkId } });
    if (!network) throw new NotFoundException('Network not found');
    if (!network.isActive) throw new ForbiddenException('Network is not active');
    if (network.isHelpdesk) {
      throw new BadRequestException('Cannot join helpdesk network directly');
    }

    const banned = await prisma.networkBannedMember.findUnique({
      where: { networkId_memberId: { networkId, memberId } },
    });
    if (banned) throw new ForbiddenException('Member is banned from this network');

    const existing = await prisma.networkMember.findUnique({
      where: { networkId_memberId: { networkId, memberId } },
    });
    if (existing) {
      return { networkId, status: 'APPROVED', alreadyJoined: true };
    }

    if (network.memberQuota && network.countMember >= network.memberQuota) {
      throw new BadRequestException('Network has reached its member quota');
    }

    if (!network.isPublic) {
      const pending = await prisma.networkMemberRequest.findUnique({
        where: { networkId_memberId: { networkId, memberId } },
      });
      if (pending && pending.status === 'PENDING') {
        return { networkId, status: 'PENDING', alreadyRequested: true };
      }
      await prisma.networkMemberRequest.upsert({
        where: { networkId_memberId: { networkId, memberId } },
        create: { networkId, memberId, status: 'PENDING' },
        update: { status: 'PENDING' },
      });
      return { networkId, status: 'PENDING' };
    }

    await prisma.$transaction([
      prisma.networkMember.create({ data: { networkId, memberId } }),
      prisma.network.update({
        where: { id: networkId },
        data: { countMember: { increment: 1 } },
      }),
    ]);
    return { networkId, status: 'APPROVED', joined: true };
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
