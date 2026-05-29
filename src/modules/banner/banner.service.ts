import { prisma } from '@bb/db';
import type { PaginationParams } from '@/common/utils/pagination.util';

export class BannerService {
  async listActive(p: PaginationParams) {
    const where = { isActive: true };
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
