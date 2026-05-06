import { prisma } from '@/config/prisma';

export class BannerService {
  async listActive() {
    return prisma.banner.findMany({
      where: { isActive: true },
      orderBy: [{ position: 'asc' }, { createdAt: 'desc' }],
    });
  }
}
