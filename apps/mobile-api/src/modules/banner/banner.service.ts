import { prisma } from '@bb/db';
import type { PaginationParams } from '@bb/common/utils/pagination.util';

export class BannerService {
  async listActive(p: PaginationParams, filter?: { isPopup?: boolean }) {
    const now = new Date();
    const where = {
      isActive: true,
      // null bound = open-ended: started <= now <= ended
      AND: [
        { OR: [{ startedAt: null }, { startedAt: { lte: now } }] },
        { OR: [{ endedAt: null }, { endedAt: { gte: now } }] },
      ],
      ...(filter?.isPopup !== undefined ? { isPopup: filter.isPopup } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.banner.findMany({
        where,
        orderBy: [{ position: 'asc' }, { createdAt: 'desc' }],
        skip: p.skip,
        take: p.take,
      }),
      prisma.banner.count({ where }),
    ]);
    return { rows, total };
  }
}
