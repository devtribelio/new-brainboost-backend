import type { Prisma, Product } from '@prisma/client';
import { prisma } from '@bb/db';
import { NotFoundException } from '@bb/common/exceptions';
import type { PaginationParams } from '@bb/common/utils/pagination.util';
import type { Ownership } from './dto/list-query.dto';

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
  async list(
    p: PaginationParams,
    q: { keyword?: string; type?: string; memberId?: string; ownership?: Ownership },
  ) {
    if (q.ownership === 'purchased' && q.memberId) {
      return this.listPurchased(p, q.memberId, { keyword: q.keyword, type: q.type });
    }

    const where: Prisma.ProductWhereInput = { isActive: true };
    if (q.keyword) where.title = { contains: q.keyword, mode: 'insensitive' };
    if (q.type) where.type = q.type;
    if (q.ownership === 'not_purchased' && q.memberId) {
      where.OR = [
        { course: null },
        { course: { enrollments: { none: { memberId: q.memberId } } } },
      ];
    }
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
    const purchasedProductIds = await this.batchPurchased(q.memberId, rows);
    return { rows, total, ratingAvgByProduct, purchasedProductIds };
  }

  // ownership=purchased: drive query off CourseEnrollment so we can paginate
  // and sort by *purchase date*, not product.createdAt. Total = enrollment count
  // for the member, so meta.pagination.total matches the filtered result.
  private async listPurchased(
    p: PaginationParams,
    memberId: string,
    filter: { keyword?: string; type?: string },
  ) {
    const enrollmentWhere: Prisma.CourseEnrollmentWhereInput = {
      memberId,
      course: {
        product: {
          isActive: true,
          ...(filter.keyword
            ? { title: { contains: filter.keyword, mode: 'insensitive' as const } }
            : {}),
          ...(filter.type ? { type: filter.type } : {}),
        },
      },
    };
    const [enrollments, total] = await Promise.all([
      prisma.courseEnrollment.findMany({
        where: enrollmentWhere,
        orderBy: { createdAt: 'desc' },
        skip: p.skip,
        take: p.take,
        select: { course: { select: { product: true } } },
      }),
      prisma.courseEnrollment.count({ where: enrollmentWhere }),
    ]);
    const rows: Product[] = enrollments.map((e) => e.course.product);
    const ratingAvgByProduct = await this.batchRatingAvg(rows.map((r) => r.id));
    const purchasedProductIds = new Set(rows.map((r) => r.id));
    return { rows, total, ratingAvgByProduct, purchasedProductIds };
  }

  private async batchPurchased(
    memberId: string | undefined,
    rows: { id: string; type: string }[],
  ): Promise<Set<string>> {
    const set = new Set<string>();
    if (!memberId) return set;
    const courseProductIds = rows.filter((r) => r.type === 'course').map((r) => r.id);
    if (courseProductIds.length === 0) return set;
    const enrollments = await prisma.courseEnrollment.findMany({
      where: { memberId, course: { productId: { in: courseProductIds } } },
      select: { course: { select: { productId: true } } },
    });
    for (const e of enrollments) set.add(e.course.productId);
    return set;
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
