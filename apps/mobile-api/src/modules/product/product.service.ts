import { Prisma } from '@prisma/client';
import type { Product } from '@prisma/client';
import { prisma } from '@bb/db';
import { NotFoundException } from '@bb/common/exceptions';
import type { PaginationParams } from '@bb/common/utils/pagination.util';
import { EntitlementService } from '@bb/domain/subscription/entitlement.service';
import type { Ownership, ProductMedia, ProductSort } from './dto/list-query.dto';

interface ListQuery {
  keyword?: string;
  type?: string;
  memberId?: string;
  ownership?: Ownership;
  sort?: ProductSort;
  media?: ProductMedia[];
}

/**
 * Enrollment VALIDITY (must mirror EntitlementService.isEnrollmentValid, BE-06):
 * retail/legacy rows (via_subscription_id NULL) count by existence; subscription
 * lazy rows only while expired_date is in the future. Used by every ownership
 * filter below so list badges and the media gate never disagree.
 */
function validEnrollmentWhere(now: Date): Prisma.CourseEnrollmentWhereInput {
  return { OR: [{ viaSubscriptionId: null }, { expiredDate: { gt: now } }] };
}

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
  constructor(private readonly entitlement = new EntitlementService()) {}

  async list(p: PaginationParams, q: ListQuery) {
    if (q.ownership === 'purchased' && q.memberId) {
      return this.listPurchased(p, q, q.memberId);
    }

    // `top_rated` orders by AVG(review.stars) and `media` scans lesson `slides_data`
    // JSONB — neither is expressible via Prisma's typed query builder, so route
    // those requests through the raw-SQL path.
    if (q.sort === 'top_rated' || (q.media != null && q.media.length > 0)) {
      return this.listRaw(p, q);
    }

    const where: Prisma.ProductWhereInput = { isActive: true };
    if (q.keyword) where.title = { contains: q.keyword, mode: 'insensitive' };
    // Subscription plan products never show in the catalog by default — the
    // paywall reads GET /subscription/plans. Explicit ?type=subscription still works.
    if (q.type) where.type = q.type;
    else where.type = { not: 'subscription' };
    if (q.ownership === 'not_purchased' && q.memberId) {
      if (await this.entitlement.hasActiveSubscription(q.memberId)) {
        // Subscribers own every course-backed product → only course-less ones remain.
        where.course = null;
      } else {
        where.OR = [
          { course: null },
          { course: { enrollments: { none: { memberId: q.memberId, ...validEnrollmentWhere(new Date()) } } } },
        ];
      }
    }
    const [rows, total] = await Promise.all([
      prisma.product.findMany({
        where,
        orderBy: ProductService.orderByFor(q.sort),
        skip: p.skip,
        take: p.take,
      }),
      prisma.product.count({ where }),
    ]);
    const ratingAvgByProduct = await this.batchRatingAvg(rows.map((r) => r.id));
    const { purchasedProductIds, viaSubscriptionIds } = await this.batchOwnership(
      q.memberId,
      rows,
    );
    return { rows, total, ratingAvgByProduct, purchasedProductIds, viaSubscriptionIds };
  }

  private static orderByFor(sort?: ProductSort): Prisma.ProductOrderByWithRelationInput {
    switch (sort) {
      case 'price_asc':
        return { price: 'asc' };
      case 'price_desc':
        return { price: 'desc' };
      case 'newest':
      default:
        return { createdAt: 'desc' };
    }
  }

  // Raw-SQL list path for filters/sorts the typed builder can't express:
  // `sort=top_rated` (orders by AVG(review.stars), not a column) and `media`
  // (EXISTS a lesson whose `slides_data` JSONB array holds an Audio/Video slide).
  // Returns product ids in result order, then hydrates Product rows preserving it.
  private async listRaw(p: PaginationParams, q: ListQuery) {
    const conds: Prisma.Sql[] = [Prisma.sql`p.is_active = true`];
    if (q.keyword) conds.push(Prisma.sql`p.title ILIKE ${`%${q.keyword}%`}`);
    if (q.type) conds.push(Prisma.sql`p.type = ${q.type}`);
    else conds.push(Prisma.sql`p.type <> 'subscription'`); // paywall products stay out of the catalog
    if (q.ownership === 'not_purchased' && q.memberId) {
      if (await this.entitlement.hasActiveSubscription(q.memberId)) {
        // Subscribers own every course-backed product → only course-less ones remain.
        conds.push(Prisma.sql`NOT EXISTS (SELECT 1 FROM courses c WHERE c.product_id = p.id)`);
      } else {
        // Only VALID enrollments count (mirror of validEnrollmentWhere):
        // retail rows by existence, lazy rows only while expired_date is future.
        conds.push(Prisma.sql`NOT EXISTS (
          SELECT 1 FROM courses c
          JOIN course_enrollment ce ON ce.course_id = c.id
          WHERE c.product_id = p.id AND ce.member_id = ${q.memberId}::uuid
            AND (ce.via_subscription_id IS NULL OR ce.expired_date > now())
        )`);
      }
    }
    if (q.media && q.media.length > 0) {
      // AND semantics: the course must contain a slide of EVERY requested media
      // kind, so each kind gets its own EXISTS (deduped). `media=audio,video`
      // therefore matches only courses that have BOTH audio and video slides.
      const slideTypes = Array.from(
        new Set(q.media.map((m) => (m === 'audio' ? 'AudioTemplate' : 'VideoTemplate'))),
      );
      for (const slideType of slideTypes) {
        conds.push(Prisma.sql`EXISTS (
          SELECT 1 FROM courses c
          JOIN course_sections cs ON cs.course_id = c.id
          JOIN course_lessons cl ON cl.section_id = cs.id
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(cl.slides_data) = 'array' THEN cl.slides_data ELSE '[]'::jsonb END
          ) AS slide
          WHERE c.product_id = p.id AND slide->>'type' = ${slideType}
        )`);
      }
    }
    const where = Prisma.join(conds, ' AND ');

    const needsRating = q.sort === 'top_rated';
    const ratingJoin = needsRating
      ? Prisma.sql`LEFT JOIN reviews r ON r.product_id = p.id`
      : Prisma.empty;
    const groupBy = needsRating ? Prisma.sql`GROUP BY p.id` : Prisma.empty;
    const orderBy =
      q.sort === 'price_asc'
        ? Prisma.sql`p.price ASC, p.created_at DESC`
        : q.sort === 'price_desc'
          ? Prisma.sql`p.price DESC, p.created_at DESC`
          : q.sort === 'top_rated'
            ? Prisma.sql`COALESCE(AVG(r.stars), 0) DESC, p.created_at DESC`
            : Prisma.sql`p.created_at DESC`;

    const idRows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT p.id
      FROM products p
      ${ratingJoin}
      WHERE ${where}
      ${groupBy}
      ORDER BY ${orderBy}
      LIMIT ${p.take} OFFSET ${p.skip}
    `;
    const countRows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM products p WHERE ${where}
    `;
    const total = Number(countRows[0]?.count ?? 0);

    const ids = idRows.map((r) => r.id);
    if (ids.length === 0) {
      return {
        rows: [] as Product[],
        total,
        ratingAvgByProduct: new Map<string, number>(),
        purchasedProductIds: new Set<string>(),
        viaSubscriptionIds: new Set<string>(),
      };
    }
    const fetched = await prisma.product.findMany({ where: { id: { in: ids } } });
    const byId = new Map(fetched.map((r) => [r.id, r]));
    const rows = ids.map((id) => byId.get(id)).filter((r): r is Product => r != null);

    const ratingAvgByProduct = await this.batchRatingAvg(ids);
    const { purchasedProductIds, viaSubscriptionIds } = await this.batchOwnership(
      q.memberId,
      rows,
    );
    return { rows, total, ratingAvgByProduct, purchasedProductIds, viaSubscriptionIds };
  }

  // ownership=purchased: drive query off CourseEnrollment so we can paginate
  // and sort by *purchase date*, not product.createdAt. Total = enrollment count
  // for the member, so meta.pagination.total matches the filtered result.
  private async listPurchased(p: PaginationParams, q: ListQuery, memberId: string) {
    const filter = { keyword: q.keyword, type: q.type };

    // A subscriber "owns" EVERY course-backed product (all-access) — drive the
    // query off products, not enrollments, so unopened courses show up too.
    if (await this.entitlement.hasActiveSubscription(memberId)) {
      const where: Prisma.ProductWhereInput = {
        isActive: true,
        course: { isNot: null },
        ...(filter.keyword
          ? { title: { contains: filter.keyword, mode: 'insensitive' as const } }
          : {}),
        ...(filter.type ? { type: filter.type } : {}),
      };
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
      const purchasedProductIds = new Set(rows.map((r) => r.id));
      // Retail-owned rows are NOT "via subscription" — lifetime beats borrowed access.
      const retailOwned = new Set(
        (
          await prisma.courseEnrollment.findMany({
            where: {
              memberId,
              viaSubscriptionId: null,
              course: { productId: { in: rows.map((r) => r.id) } },
            },
            select: { course: { select: { productId: true } } },
          })
        ).map((e) => e.course.productId),
      );
      const viaSubscriptionIds = new Set(
        rows.map((r) => r.id).filter((id) => !retailOwned.has(id)),
      );
      return { rows, total, ratingAvgByProduct, purchasedProductIds, viaSubscriptionIds };
    }

    const enrollmentWhere: Prisma.CourseEnrollmentWhereInput = {
      memberId,
      ...validEnrollmentWhere(new Date()), // lapsed lazy rows are not "owned"
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
        select: { viaSubscriptionId: true, course: { select: { product: true } } },
      }),
      prisma.courseEnrollment.count({ where: enrollmentWhere }),
    ]);
    const rows: Product[] = enrollments.map((e) => e.course.product);
    const ratingAvgByProduct = await this.batchRatingAvg(rows.map((r) => r.id));
    const purchasedProductIds = new Set(rows.map((r) => r.id));
    const viaSubscriptionIds = new Set(
      enrollments.filter((e) => e.viaSubscriptionId !== null).map((e) => e.course.product.id),
    );
    return { rows, total, ratingAvgByProduct, purchasedProductIds, viaSubscriptionIds };
  }

  /**
   * Ownership per page row: `purchasedProductIds` = owned at all (badge), and
   * `viaSubscriptionIds` ⊆ purchased = owned ONLY through the subscription —
   * a valid RETAIL enrollment always wins (lifetime beats borrowed access), so
   * a retail-owned course is purchased=true / viaSubscription=false even for
   * an active subscriber.
   */
  private async batchOwnership(
    memberId: string | undefined,
    rows: { id: string; type: string }[],
  ): Promise<{ purchasedProductIds: Set<string>; viaSubscriptionIds: Set<string> }> {
    const purchasedProductIds = new Set<string>();
    const viaSubscriptionIds = new Set<string>();
    const result = { purchasedProductIds, viaSubscriptionIds };
    if (!memberId) return result;
    // Course-backed types (course + mini_course) carry enrollment; gating on
    // 'course' alone hid owned mini_course products from the list. Enrollment
    // existence is the real ownership signal — the join below filters anyway.
    const courseProductIds = rows
      .filter((r) => r.type === 'course' || r.type === 'mini_course')
      .map((r) => r.id);
    if (courseProductIds.length === 0) return result;

    const enrollments = await prisma.courseEnrollment.findMany({
      where: {
        memberId,
        ...validEnrollmentWhere(new Date()), // lapsed lazy rows don't badge as owned
        course: { productId: { in: courseProductIds } },
      },
      select: { viaSubscriptionId: true, course: { select: { productId: true } } },
    });
    const retailOwned = new Set(
      enrollments.filter((e) => e.viaSubscriptionId === null).map((e) => e.course.productId),
    );

    // All-access: an active subscription marks every course-backed row purchased.
    if (await this.entitlement.hasActiveSubscription(memberId)) {
      for (const id of courseProductIds) {
        purchasedProductIds.add(id);
        if (!retailOwned.has(id)) viaSubscriptionIds.add(id);
      }
      return result;
    }

    for (const e of enrollments) {
      purchasedProductIds.add(e.course.productId);
      if (e.viaSubscriptionId !== null) viaSubscriptionIds.add(e.course.productId);
    }
    return result;
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
    if (!product) {
      // Slug fallback. Affiliate OneLinks/deeplinks historically put the
      // product *slug* (from `/p/<slug>`) in the `product` param rather than the
      // short `code`, so the mobile client opens `/course/detail/<slug>`. Resolve
      // by slug too. `slug` is not unique, so take the first active match
      // deterministically (UUID v7 ids are time-ordered).
      product = await prisma.product.findFirst({
        where: { slug: productInput },
        orderBy: { id: 'asc' },
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
