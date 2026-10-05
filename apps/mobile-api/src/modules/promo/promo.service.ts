import type { Product, Voucher } from '@prisma/client';
import { prisma } from '@bb/db';
import type { ProductService } from '@/modules/product/product.service';
import { LISTABLE_PRODUCT_TYPES } from '@/modules/product/dto/list-query.dto';
import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import { compareSemver } from '../app-version/version.util';

/** What the client tells us about itself on `GET /promo/public`. Both optional. */
export interface PromoClientInfo {
  platform?: string;
  version?: string;
}

const VERSION_RANGE_KEYS: Record<string, { min: string; max: string }> = {
  android: { min: SETTING_KEYS.promoMinVersionAndroid, max: SETTING_KEYS.promoMaxVersionAndroid },
  ios: { min: SETTING_KEYS.promoMinVersionIos, max: SETTING_KEYS.promoMaxVersionIos },
};

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
  async listActive(memberId?: string, client?: PromoClientInfo) {
    if (await this.isHiddenForClient(client)) {
      return {
        promos: [] as ActivePromo[],
        ratingAvgByProduct: new Map<string, number>(),
        purchasedProductIds: new Set<string>(),
      };
    }

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

  /**
   * Mobile-only version window: promos are shown on `promo.minVersion<Platform>` up to
   * `promo.maxVersion<Platform>`, both INCLUSIVE, empty = unbounded. Exists so a promo can
   * run on prod while only an unreleased internal build sees it.
   *
   * The opposite of the banner gate on purpose:
   * - No `platform` (or not android/ios) = the web shop, which is never gated.
   * - On mobile with a bound set, it fails CLOSED: no or unparseable `version` hides the
   *   list, since the whole point is to keep it away from builds we cannot place. Safe
   *   because no build older than this endpoint calls it.
   *
   * Not access control: `version` is client-supplied, and the voucher stays redeemable at
   * checkout by anyone holding the code.
   */
  private async isHiddenForClient(client?: PromoClientInfo): Promise<boolean> {
    const keys = client?.platform ? VERSION_RANGE_KEYS[client.platform] : undefined;
    if (!keys) return false;

    const [min, max] = await Promise.all([
      settingsService.get(keys.min, '').then((v) => v.trim()),
      settingsService.get(keys.max, '').then((v) => v.trim()),
    ]);
    if (!min && !max) return false; // gate off

    const version = client?.version ?? '';
    // compareSemver returns null when either side is unparseable -> hidden.
    if (min && (compareSemver(version, min) ?? -1) < 0) return true;
    if (max && (compareSemver(version, max) ?? 1) > 0) return true;
    return false;
  }
}

function earlier(a: Date | null, b: Date | null): Date | null {
  if (!a || !b) return a ?? b;
  return a < b ? a : b;
}
