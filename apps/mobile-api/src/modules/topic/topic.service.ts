import { prisma } from '@bb/db';
import { BadRequestException, NotFoundException } from '@bb/common/exceptions';
import type { PaginationParams } from '@bb/common/utils/pagination.util';
import { assertUuid } from '@bb/common/utils/uuid.util';

interface TopicListQuery {
  keyword?: string;
  // Network code (8-char alphanumeric), legacyId int, or backend UUID.
  networkInput?: string;
  // Authed member id. When provided, each row gets `isSubscribed` set.
  memberId?: string;
  // Filter by subscription state of the authed member. Anonymous callers are
  // treated as subscribed-to-nothing: true → empty, false → no-op.
  isSubscribe?: boolean;
}

export interface TopicSubscribeResult {
  topicId: string;
  topicLegacyId: number | null;
  memberLegacyId: number | null;
  isSubscribeTopic: boolean;
  status: 'APPROVED' | 'PENDING' | 'UNSUBSCRIBED';
  alreadySubscribed?: boolean;
  alreadyRequested?: boolean;
  unsubscribed?: boolean;
}

export class TopicService {
  async list(p: PaginationParams, q: TopicListQuery) {
    const where: Record<string, unknown> = { isActive: true };
    if (q.keyword) where.name = { contains: q.keyword, mode: 'insensitive' };
    if (q.networkInput) {
      const networkId = await this.resolveNetworkId(q.networkInput);
      if (!networkId) return { rows: [], total: 0 };
      where.networkId = networkId;
    }
    if (q.isSubscribe !== undefined) {
      if (q.memberId) {
        where.subscriptions = q.isSubscribe
          ? { some: { memberId: q.memberId } }
          : { none: { memberId: q.memberId } };
      } else if (q.isSubscribe) {
        return { rows: [], total: 0 };
      }
    }

    const [rows, total] = await Promise.all([
      prisma.topic.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: p.skip,
        take: p.take,
      }),
      prisma.topic.count({ where }),
    ]);

    if (!q.memberId || rows.length === 0) {
      return { rows, total };
    }

    // Filter already pins the subscription state of every row.
    if (q.isSubscribe !== undefined) {
      const decorated = rows.map((r) => Object.assign(r, { isSubscribed: q.isSubscribe }));
      return { rows: decorated, total };
    }

    const topicIds = rows.map((r) => r.id);
    const subs = await prisma.topicSubscription.findMany({
      where: { memberId: q.memberId, topicId: { in: topicIds } },
      select: { topicId: true },
    });
    const subscribed = new Set(subs.map((s) => s.topicId));
    const decorated = rows.map((r) => Object.assign(r, { isSubscribed: subscribed.has(r.id) }));
    return { rows: decorated, total };
  }

  // FE sends `code` (8-char alphanumeric from /info). Backend accepts code,
  // legacyId int, or backend UUID. Mirrors `network.service::resolveNetworkId`
  // — duplicated rather than cross-module import to keep services self-contained.
  private async resolveNetworkId(input: string): Promise<string | null> {
    if (!input) return null;
    const byCode = await prisma.network.findUnique({ where: { code: input }, select: { id: true } });
    if (byCode) return byCode.id;
    const legacyId = Number.parseInt(input, 10);
    if (Number.isFinite(legacyId) && input === String(legacyId)) {
      const byLegacy = await prisma.network.findUnique({
        where: { legacyId },
        select: { id: true },
      });
      if (byLegacy) return byLegacy.id;
    }
    assertUuid(input);
    const byId = await prisma.network.findUnique({ where: { id: input }, select: { id: true } });
    return byId?.id ?? null;
  }

  // Topics carry `legacyId Int? @unique` (mobile-compat). FE may send either
  // the int legacyId or the UUID. Match comment/post pattern.
  private async resolveTopicByAnyId(input: string) {
    const asInt = Number.parseInt(input, 10);
    if (Number.isFinite(asInt) && input === String(asInt)) {
      const byLegacy = await prisma.topic.findUnique({ where: { legacyId: asInt } });
      if (byLegacy) return byLegacy;
    }
    assertUuid(input);
    return prisma.topic.findUnique({ where: { id: input } });
  }

  async subscribe(memberId: string, topicInput: string): Promise<TopicSubscribeResult> {
    const member = await prisma.member.findUnique({
      where: { id: memberId },
      select: { id: true, legacyId: true, isActive: true },
    });
    if (!member || !member.isActive) {
      throw new BadRequestException('Member is not active');
    }

    const topic = await this.resolveTopicByAnyId(topicInput);
    if (!topic) throw new NotFoundException('Topic not found');
    if (!topic.isActive) throw new BadRequestException('Topic is not active');

    if (topic.networkId) {
      const networkMember = await prisma.networkMember.findUnique({
        where: { networkId_memberId: { networkId: topic.networkId, memberId } },
      });
      if (!networkMember) {
        throw new BadRequestException('Must join the parent network before subscribing to topic');
      }
    }

    const base = {
      topicId: topic.id,
      topicLegacyId: topic.legacyId,
      memberLegacyId: member.legacyId,
    };

    if (topic.type === 'PRIVATE') {
      const existing = await prisma.topicSubscription.findUnique({
        where: { memberId_topicId: { memberId, topicId: topic.id } },
      });
      if (existing) {
        return { ...base, isSubscribeTopic: true, status: 'APPROVED', alreadySubscribed: true };
      }

      const pendingOrApproved = await prisma.topicJoinRequest.findUnique({
        where: { topicId_memberId: { topicId: topic.id, memberId } },
      });
      if (pendingOrApproved) {
        if (pendingOrApproved.status === 'PENDING') {
          return { ...base, isSubscribeTopic: false, status: 'PENDING', alreadyRequested: true };
        }
        if (pendingOrApproved.status === 'APPROVED') {
          return { ...base, isSubscribeTopic: true, status: 'APPROVED', alreadySubscribed: true };
        }
      }
      await prisma.topicJoinRequest.upsert({
        where: { topicId_memberId: { topicId: topic.id, memberId } },
        create: { topicId: topic.id, memberId, status: 'PENDING' },
        update: { status: 'PENDING' },
      });
      return { ...base, isSubscribeTopic: false, status: 'PENDING' };
    }

    await prisma.topicSubscription.upsert({
      where: { memberId_topicId: { memberId, topicId: topic.id } },
      create: { memberId, topicId: topic.id },
      update: {},
    });
    return { ...base, isSubscribeTopic: true, status: 'APPROVED' };
  }

  async unsubscribe(memberId: string, topicInput: string): Promise<TopicSubscribeResult> {
    const member = await prisma.member.findUnique({
      where: { id: memberId },
      select: { id: true, legacyId: true },
    });
    const topic = await this.resolveTopicByAnyId(topicInput);
    if (!topic) throw new NotFoundException('Topic not found');

    await prisma.topicSubscription.deleteMany({ where: { memberId, topicId: topic.id } });
    await prisma.topicJoinRequest.updateMany({
      where: { topicId: topic.id, memberId, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
    return {
      topicId: topic.id,
      topicLegacyId: topic.legacyId,
      memberLegacyId: member?.legacyId ?? null,
      isSubscribeTopic: false,
      status: 'UNSUBSCRIBED',
      unsubscribed: true,
    };
  }
}
