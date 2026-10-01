import type { Product, Voucher } from '@prisma/client';
import { prisma } from '@bb/db';
import type { ProductService } from '@/modules/product/product.service';
import { LISTABLE_PRODUCT_TYPES } from '@/modules/product/dto/list-query.dto';

export interface ActivePromo {
  slug: string;
  title: string;
  subtitle: string | null;
  endsAt: Date | null;
  voucher: Pick<Voucher, 'code' | 'type' | 'value' | 'maxAmount' | 'endsAt'>;
  products: Product[];
}

export class PromoService {
  constructor(private readonly productService: ProductService) {}

  /**
   * Promos to show on the landing page. A promo is listed only while its voucher is
   * one ANY visitor could redeem right now — otherwise the page would advertise a
   * price the checkout then refuses. A promo that fails any rule is simply absent.
   */
  async listActive(memberId?: string) {
    const now = new Date();
    const rows = await prisma.promo.findMany({
      where: {
        isActive: true,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
        ],
        voucher: {
          isActive: true,
          // Never TRIAL: that is time-boxed access, not a price.
          type: { in: ['PERCENT', 'AMOUNT'] },
          // A member-owned or program-issued code must not leak through a public endpoint.
          ownerMemberId: null,
          campaign: null,
          AND: [
            { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
            { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
          ],
        },
      },
      orderBy: [{ position: 'asc' }, { createdAt: 'desc' }],
      include: {
        voucher: { include: { products: { select: { productId: true } } } },
        products: {
          // Same catalog filter as `product/list/public`.
          where: { product: { isActive: true, type: { in: [...LISTABLE_PRODUCT_TYPES] } } },
          orderBy: { position: 'asc' },
          include: { product: true },
        },
      },
    });

    const promos: ActivePromo[] = [];
    for (const r of rows) {
      const v = r.voucher;
      if (v.quota != null && v.used >= v.quota) continue;
      // Zero `voucher_products` rows = a global voucher; otherwise only the listed products.
      const scope = new Set(v.products.map((p) => p.productId));
      const products = r.products
        .map((pp) => pp.product)
        .filter((p) => scope.size === 0 || scope.has(p.id));
      if (products.length === 0) continue;
      promos.push({
        slug: r.slug,
        title: r.title,
        subtitle: r.subtitle,
        endsAt: earlier(r.endsAt, v.endsAt),
        voucher: v,
        products,
      });
    }

    const all = promos.flatMap((p) => p.products);
    const [ratingAvgByProduct, purchasedProductIds] = await Promise.all([
      this.productService.batchRatingAvg(all.map((p) => p.id)),
      this.productService.batchPurchased(memberId, all),
    ]);
    return { promos, ratingAvgByProduct, purchasedProductIds };
  }
}

function earlier(a: Date | null, b: Date | null): Date | null {
  if (!a || !b) return a ?? b;
  return a < b ? a : b;
}
