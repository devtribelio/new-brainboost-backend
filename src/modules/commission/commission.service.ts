import { prisma } from '@/config/prisma';

export class CommissionService {
  async summary(memberId: string) {
    const [agg, recent] = await Promise.all([
      prisma.affiliateCommission.aggregate({
        where: { recipientId: memberId, status: { in: ['PENDING', 'BALANCE'] } },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.affiliateCommission.findMany({
        where: { recipientId: memberId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);
    return {
      total: agg._sum.amount ?? 0,
      count: agg._count,
      currency: 'IDR',
      recent: recent.map((e) => ({
        id: e.id,
        amount: e.amount,
        status: e.status,
        source: e.source,
        createdAt: e.createdAt,
      })),
    };
  }
}
