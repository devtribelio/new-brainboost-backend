import { prisma } from '@/config/prisma';

export class CommissionService {
  async summary(memberId: string) {
    const [agg, recent] = await Promise.all([
      prisma.commissionEntry.aggregate({
        where: { memberId },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.commissionEntry.findMany({
        where: { memberId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);
    return {
      total: agg._sum.amount ?? 0,
      count: agg._count,
      currency: recent[0]?.currency ?? 'IDR',
      recent: recent.map((e) => ({
        id: e.id,
        amount: e.amount,
        currency: e.currency,
        source: e.source,
        createdAt: e.createdAt,
      })),
    };
  }
}
