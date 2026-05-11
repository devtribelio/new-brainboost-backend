import { prisma } from '@/config/prisma';
import { NotFoundException } from '@/common/exceptions';
import type { PaginationParams } from '@/common/utils/pagination.util';

export interface ReviewAggregate {
  avg: number;
  total: number;
  distribution: Record<string, number>;
}

function emptyDistribution(): Record<string, number> {
  return { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
}

function distributionFromGroupBy(
  rows: { stars: number; _count: { stars: number } }[],
): Record<string, number> {
  const out = emptyDistribution();
  for (const r of rows) {
    const key = String(r.stars);
    if (key in out) out[key] = r._count.stars;
  }
  return out;
}

export class ProductService {
  async list(p: PaginationParams, q: { keyword?: string; type?: string }) {
    const where: Record<string, unknown> = { isActive: true };
    if (q.keyword) where.title = { contains: q.keyword, mode: 'insensitive' };
    if (q.type) where.type = q.type;
    const [rows, total] = await Promise.all([
      prisma.product.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: p.skip,
        take: p.take,
      }),
      prisma.product.count({ where }),
    ]);
    const ratingAvgByProduct = await this.batchRatingAvg(rows.map((r) => r.id));
    return { rows, total, ratingAvgByProduct };
  }

  private async batchRatingAvg(productIds: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (productIds.length === 0) return map;
    const grouped = await prisma.review.groupBy({
      by: ['productId'],
      where: { productId: { in: productIds } },
      _avg: { stars: true },
    });
    for (const g of grouped) {
      map.set(g.productId, g._avg.stars ?? 0);
    }
    return map;
  }

  async courseDetail(productInput: string) {
    const legacyId = Number.parseInt(productInput, 10);
    let product = null;
    if (Number.isFinite(legacyId) && productInput === String(legacyId)) {
      product = await prisma.product.findUnique({
        where: { legacyId },
        include: {
          course: {
            include: {
              sections: {
                orderBy: { order: 'asc' },
                include: { lessons: { orderBy: { order: 'asc' } } },
              },
            },
          },
        },
      });
    }
    if (!product) {
      product = await prisma.product.findUnique({
        where: { code: productInput },
        include: {
          course: {
            include: {
              sections: {
                orderBy: { order: 'asc' },
                include: { lessons: { orderBy: { order: 'asc' } } },
              },
            },
          },
        },
      });
    }
    if (!product) throw new NotFoundException('Product not found');

    const [grouped, agg] = await Promise.all([
      prisma.review.groupBy({
        by: ['stars'],
        where: { productId: product.id },
        _count: { stars: true },
      }),
      prisma.review.aggregate({
        where: { productId: product.id },
        _avg: { stars: true },
        _count: { _all: true },
      }),
    ]);
    const reviewAggregate: ReviewAggregate = {
      avg: agg._avg.stars ?? 0,
      total: agg._count._all,
      distribution: distributionFromGroupBy(grouped),
    };
    return { product, reviewAggregate };
  }
}
