import { prisma } from '@/config/prisma';
import { BadRequestException, NotFoundException } from '@/common/exceptions';
import type { PaginationParams } from '@/common/utils/pagination.util';

interface TopicListQuery {
  keyword?: string;
  networkId?: string;
}

export class TopicService {
  async list(p: PaginationParams, q: TopicListQuery) {
    const where: Record<string, unknown> = { isActive: true };
    if (q.keyword) where.name = { contains: q.keyword, mode: 'insensitive' };
    if (q.networkId) where.networkId = q.networkId;

    const [rows, total] = await Promise.all([
      prisma.topic.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: p.skip,
        take: p.take,
      }),
      prisma.topic.count({ where }),
    ]);
    return { rows, total };
  }

  async subscribe(memberId: string, topicId: string) {
    const member = await prisma.member.findUnique({ where: { id: memberId } });
    if (!member || !member.isActive) {
      throw new BadRequestException('Member is not active');
    }

    const topic = await prisma.topic.findUnique({ where: { id: topicId } });
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

    if (topic.type === 'PRIVATE') {
      const existing = await prisma.topicSubscription.findUnique({
        where: { memberId_topicId: { memberId, topicId } },
      });
      if (existing) return { topicId, status: 'APPROVED', alreadySubscribed: true };

      const pendingOrApproved = await prisma.topicJoinRequest.findUnique({
        where: { topicId_memberId: { topicId, memberId } },
      });
      if (pendingOrApproved) {
        if (pendingOrApproved.status === 'PENDING') {
          return { topicId, status: 'PENDING', alreadyRequested: true };
        }
        if (pendingOrApproved.status === 'APPROVED') {
          return { topicId, status: 'APPROVED', alreadySubscribed: true };
        }
      }
      await prisma.topicJoinRequest.upsert({
        where: { topicId_memberId: { topicId, memberId } },
        create: { topicId, memberId, status: 'PENDING' },
        update: { status: 'PENDING' },
      });
      return { topicId, status: 'PENDING' };
    }

    await prisma.topicSubscription.upsert({
      where: { memberId_topicId: { memberId, topicId } },
      create: { memberId, topicId },
      update: {},
    });
    return { topicId, status: 'APPROVED' };
  }

  async unsubscribe(memberId: string, topicId: string) {
    await prisma.topicSubscription.deleteMany({ where: { memberId, topicId } });
    await prisma.topicJoinRequest.updateMany({
      where: { topicId, memberId, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
    return { topicId, unsubscribed: true };
  }
}
