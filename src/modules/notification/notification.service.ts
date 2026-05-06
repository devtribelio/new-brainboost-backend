import { prisma } from '@/config/prisma';
import type { PaginationParams } from '@/common/utils/pagination.util';

export class NotificationService {
  async listForMember(p: PaginationParams, memberId: string) {
    const where = { memberId };
    const [rows, total, unread] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: p.skip,
        take: p.take,
      }),
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { ...where, seenAt: null } }),
    ]);
    return { rows, total, unread };
  }

  async markSeen(memberId: string, notificationIds?: string[]) {
    const where: Record<string, unknown> = { memberId, seenAt: null };
    if (notificationIds && notificationIds.length > 0) where.id = { in: notificationIds };
    return prisma.notification.updateMany({
      where,
      data: { seenAt: new Date() },
    });
  }
}
