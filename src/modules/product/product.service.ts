import { prisma } from '@/config/prisma';
import { NotFoundException } from '@/common/exceptions';
import type { PaginationParams } from '@/common/utils/pagination.util';

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
    return { rows, total };
  }

  async courseDetail(productInput: string) {
    const legacyId = Number.parseInt(productInput, 10);
    let product = null;
    if (Number.isFinite(legacyId) && productInput === String(legacyId)) {
      product = await prisma.product.findUnique({
        where: { legacyId },
        include: { course: true },
      });
    }
    if (!product) {
      product = await prisma.product.findUnique({
        where: { code: productInput },
        include: { course: true },
      });
    }
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }
}
