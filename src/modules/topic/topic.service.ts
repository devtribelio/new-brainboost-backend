import { prisma } from '@/config/prisma';
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
    return prisma.topicSubscription.upsert({
      where: { memberId_topicId: { memberId, topicId } },
      create: { memberId, topicId },
      update: {},
    });
  }

  async unsubscribe(memberId: string, topicId: string) {
    return prisma.topicSubscription.deleteMany({ where: { memberId, topicId } });
  }
}
