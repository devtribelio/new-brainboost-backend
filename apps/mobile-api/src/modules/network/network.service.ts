import { Prisma } from '@prisma/client';
import { prisma } from '@bb/db';
import { badRequest, forbidden, notFound, ERROR_CODES } from '@bb/common/exceptions';
import type { PaginationParams } from '@bb/common/utils/pagination.util';
import { notificationEvents } from '@bb/common/events/notification-events';
import { assertUuid } from '@bb/common/utils/uuid.util';
import { PUBLISHED_STATUS_FILTER } from '@bb/common/utils/post-status.util';

export class NetworkService {
  private async resolveNetworkId(input: string): Promise<string | null> {
    if (!input) return null;
    // Try by `code` first (mobile sends 8-char alphanumeric code from /info)
    const byCode = await prisma.network.findUnique({
      where: { code: input },
      select: { id: true },
    });
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
    assertUuid(input);
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
            avatarUrl: true,
            coverUrl: true,
            bio: true,
            phone: true,
            gender: true,
            birthdate: true,
            isEmailVerified: true,
            isPhoneVerified: true,
            createdAt: true,
            code: true,
            profile: {
              select: {
                address: true,
                postalCode: true,
                province: { select: { legacyId: true, name: true } },
                city: { select: { legacyId: true, name: true } },
              },
            },
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

  async listTags(p: PaginationParams, networkInput: string, keyword?: string) {
    const where: Prisma.NetworkTagWhereInput = {};
    if (networkInput) {
      const networkId = await this.resolveNetworkId(networkInput);
      if (!networkId) return { rows: [], total: 0, countByTag: new Map<string, number>() };
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
    // Per-tag post count via naive `#<tag>` content match. No PostTag
    // relation exists in schema — would need migration to optimize.
    // O(rows.length) parallel queries; acceptable for default perPage <= 50.
    const counts = await Promise.all(
      rows.map((t) =>
        prisma.post.count({
          where: {
            isDeleted: false,
            publishStatus: PUBLISHED_STATUS_FILTER,
            content: { contains: `#${t.name}`, mode: 'insensitive' },
          },
        }),
      ),
    );
    const countByTag = new Map(rows.map((t, i) => [t.id, counts[i]]));
    return { rows, total, countByTag };
  }

  async join(memberId: string, networkInput: string) {
    const member = await prisma.member.findUnique({ where: { id: memberId } });
    if (!member) throw notFound(ERROR_CODES.MEMBER_NOT_FOUND);
    if (!member.isActive) throw forbidden(ERROR_CODES.MEMBER_INACTIVE);

    const networkId = await this.resolveNetworkId(networkInput);
    if (!networkId) throw notFound(ERROR_CODES.NETWORK_NOT_FOUND);

    const network = await prisma.network.findUnique({ where: { id: networkId } });
    if (!network) throw notFound(ERROR_CODES.NETWORK_NOT_FOUND);
    if (!network.isActive) throw forbidden(ERROR_CODES.NETWORK_INACTIVE);
    if (network.isHelpdesk) {
      throw badRequest(ERROR_CODES.NETWORK_HELPDESK_JOIN_FORBIDDEN);
    }

    const banned = await prisma.networkBannedMember.findUnique({
      where: { networkId_memberId: { networkId, memberId } },
    });
    if (banned) throw forbidden(ERROR_CODES.NETWORK_MEMBER_BANNED);

    const existing = await prisma.networkMember.findUnique({
      where: { networkId_memberId: { networkId, memberId } },
    });
    if (existing) {
      return { networkId, status: 'APPROVED', alreadyJoined: true };
    }

    if (!network.isPublic) {
      const pending = await prisma.networkMemberRequest.findUnique({
        where: { networkId_memberId: { networkId, memberId } },
      });
      if (pending && pending.status === 'PENDING') {
        return { networkId, status: 'PENDING', alreadyRequested: true };
      }
      const upserted = await prisma.networkMemberRequest.upsert({
        where: { networkId_memberId: { networkId, memberId } },
        create: { networkId, memberId, status: 'PENDING' },
        update: { status: 'PENDING' },
      });
      notificationEvents.emit('network.member.requested', {
        requestId: upserted.id,
        networkId,
        memberId,
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
    notificationEvents.emit('network.member.joined', { networkId, memberId });
    return { networkId, status: 'APPROVED', joined: true };
  }

  private async assertTeamMember(networkId: string, memberId: string) {
    const team = await prisma.networkTeamMember.findUnique({
      where: { networkId_memberId: { networkId, memberId } },
    });
    if (!team) throw forbidden(ERROR_CODES.NETWORK_TEAM_ONLY);
  }

  private async resolvePendingRequest(opts: {
    requestId?: string;
    networkInput?: string;
    memberId?: string;
  }) {
    if (opts.requestId) {
      const r = await prisma.networkMemberRequest.findUnique({ where: { id: opts.requestId } });
      if (!r) throw notFound(ERROR_CODES.JOIN_REQUEST_NOT_FOUND);
      return r;
    }
    if (opts.networkInput && opts.memberId) {
      const networkId = await this.resolveNetworkId(opts.networkInput);
      if (!networkId) throw notFound(ERROR_CODES.NETWORK_NOT_FOUND);
      const r = await prisma.networkMemberRequest.findUnique({
        where: { networkId_memberId: { networkId, memberId: opts.memberId } },
      });
      if (!r) throw notFound(ERROR_CODES.JOIN_REQUEST_NOT_FOUND);
      return r;
    }
    throw badRequest(ERROR_CODES.JOIN_REQUEST_PARAMS_REQUIRED);
  }

  async approveRequest(
    approverId: string,
    opts: { requestId?: string; networkInput?: string; memberId?: string },
  ) {
    const req = await this.resolvePendingRequest(opts);
    if (req.status !== 'PENDING') {
      throw badRequest(ERROR_CODES.JOIN_REQUEST_ALREADY_RESOLVED, { status: req.status });
    }
    await this.assertTeamMember(req.networkId, approverId);

    const banned = await prisma.networkBannedMember.findUnique({
      where: { networkId_memberId: { networkId: req.networkId, memberId: req.memberId } },
    });
    if (banned) throw forbidden(ERROR_CODES.JOIN_REQUEST_MEMBER_BANNED);

    await prisma.$transaction(async (tx) => {
      await tx.networkMemberRequest.update({
        where: { id: req.id },
        data: { status: 'APPROVED' },
      });
      await tx.networkMember.upsert({
        where: { networkId_memberId: { networkId: req.networkId, memberId: req.memberId } },
        create: { networkId: req.networkId, memberId: req.memberId },
        update: {},
      });
      await tx.network.update({
        where: { id: req.networkId },
        data: { countMember: { increment: 1 } },
      });
    });

    notificationEvents.emit('network.member.approved', {
      requestId: req.id,
      networkId: req.networkId,
      memberId: req.memberId,
      approverId,
    });
    notificationEvents.emit('network.member.joined', {
      networkId: req.networkId,
      memberId: req.memberId,
    });

    return {
      requestId: req.id,
      networkId: req.networkId,
      memberId: req.memberId,
      status: 'APPROVED',
    };
  }

  async rejectRequest(
    approverId: string,
    opts: { requestId?: string; networkInput?: string; memberId?: string },
  ) {
    const req = await this.resolvePendingRequest(opts);
    if (req.status !== 'PENDING') {
      throw badRequest(ERROR_CODES.JOIN_REQUEST_ALREADY_RESOLVED, { status: req.status });
    }
    await this.assertTeamMember(req.networkId, approverId);

    await prisma.networkMemberRequest.update({
      where: { id: req.id },
      data: { status: 'REJECTED' },
    });

    return {
      requestId: req.id,
      networkId: req.networkId,
      memberId: req.memberId,
      status: 'REJECTED',
    };
  }

  async leave(memberId: string, networkInput: string) {
    const networkId = await this.resolveNetworkId(networkInput);
    if (!networkId) throw badRequest(ERROR_CODES.NETWORK_NOT_FOUND);
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
