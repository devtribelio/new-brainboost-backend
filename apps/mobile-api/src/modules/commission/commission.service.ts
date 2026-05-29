import { prisma } from '@bb/db';

export class CommissionService {
  async summary(memberId: string) {
    const [agg, recent] = await Promise.all([
      prisma.affiliateCommission.aggregate({
        where: { recipientId: memberId, status: { in: ['PENDING', 'BALANCE'] } },
        _sum: { amount: true, productPrice: true },
        _count: true,
      }),
      prisma.affiliateCommission.findMany({
        where: { recipientId: memberId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);
    const totalAmount = agg._sum.amount ?? 0;
    const totalSales = agg._sum.productPrice ?? 0;
    return {
      // Legacy field names (FE legacy CommisionModel — typos preserved).
      // FE maps `totalCommision`→totalSales (commission earned),
      // `totalTransactionSales`→totalTransaction (gross sale value).
      totalCommision: totalAmount,
      totalTransactionSales: totalSales,
      // Modern aliases
      total: totalAmount,
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
