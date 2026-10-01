import { computeTotals } from '@bb/domain/commerce/utils/compute-totals';
import { serializeProduct } from '@/modules/product/product.serializer';
import type { ActivePromo } from './promo.service';

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

/** ISO-8601 in WIB with an explicit offset, e.g. `2026-10-15T23:59:59+07:00`. */
function toIsoWib(d: Date): string {
  return `${new Date(d.getTime() + WIB_OFFSET_MS).toISOString().slice(0, 19)}+07:00`;
}

export function serializePromo(
  promo: ActivePromo,
  opts: {
    ratingAvgByProduct: Map<string, number>;
    purchasedProductIds: Set<string>;
    commissionRate?: number;
  },
): Record<string, unknown> {
  const { type, value, maxAmount } = promo.voucher;
  return {
    slug: promo.slug,
    title: promo.title,
    subtitle: promo.subtitle,
    voucherCode: promo.voucher.code,
    endsAt: promo.endsAt ? toIsoWib(promo.endsAt) : null,
    products: promo.products.map((p) => ({
      ...serializeProduct(p, {
        ratingAvg: opts.ratingAvgByProduct.get(p.id) ?? 0,
        isPurchased: opts.purchasedProductIds.has(p.id),
        commissionRate: opts.commissionRate,
      }),
      // The checkout's own arithmetic (floor, cap, clamp), tax left out: catalog
      // prices are pre-PPN, and the card must match the quote before tax.
      promoPrice: computeTotals({
        unitPrice: p.price,
        qty: 1,
        voucher: { type: type as 'PERCENT' | 'AMOUNT', value, maxAmount },
        taxRate: 0,
      }).amount,
    })),
  };
}
