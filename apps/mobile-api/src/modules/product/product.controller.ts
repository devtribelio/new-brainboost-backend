import type { Request, Response } from 'express';
import { ProductService } from './product.service';
import type { AffiliatorService } from '@bb/domain/affiliate/affiliator.service';
import { EntitlementService } from '@bb/domain/subscription/entitlement.service';
import { ok, okPaginated } from '@bb/common/utils/response.util';
import { BadRequestException } from '@bb/common/exceptions';
import { parsePagination } from '@bb/common/utils/pagination.util';
import { serializeProduct, serializeCourseDetailLegacy } from './product.serializer';
import { prisma } from '@bb/db';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@bb/common/openapi/decorators';
import { CourseDetailDto, ProductDto, ProductShareDto } from './dto/product.dto';
import {
  ListProductsQueryDto,
  MEDIA_VALUES,
  OWNERSHIP_VALUES,
  PRODUCT_TYPE_VALUES,
  SORT_VALUES,
} from './dto/list-query.dto';

@ApiTags('Product')
export class ProductController {
  constructor(
    private readonly productService: ProductService,
    private readonly affiliatorService: AffiliatorService,
    private readonly entitlement = new EntitlementService(),
  ) {}

  @ApiOperation({ summary: 'List products' })
  @ApiQuery({ name: 'page', type: 'integer', required: false, example: 1 })
  @ApiQuery({ name: 'perPage', type: 'integer', required: false, example: 100 })
  @ApiQuery({ name: 'keyword', type: 'string', required: false, example: 'react' })
  @ApiQuery({
    name: 'type',
    type: 'string',
    required: false,
    enum: PRODUCT_TYPE_VALUES as unknown as string[],
    example: 'course',
  })
  @ApiQuery({
    name: 'sort',
    type: 'string',
    required: false,
    enum: SORT_VALUES as unknown as string[],
    example: 'newest',
  })
  @ApiQuery({
    name: 'media',
    type: 'array',
    itemType: 'string',
    required: false,
    enum: MEDIA_VALUES as unknown as string[],
    example: 'audio',
  })
  @ApiQuery({
    name: 'ownership',
    type: 'string',
    required: false,
    enum: OWNERSHIP_VALUES as unknown as string[],
    example: 'purchased',
  })
  @ApiResponse({
    status: 200,
    type: () => ProductDto,
    isArray: true,
    envelope: 'paginated',
  })
  list = async (req: Request, res: Response) => {
    const p = parsePagination(req.query as Record<string, unknown>, { perPage: 100 });
    const q = req.query as unknown as ListProductsQueryDto;
    const memberId = (req as { user?: { id?: string } }).user?.id;
    const { rows, total, ratingAvgByProduct, purchasedProductIds, viaSubscriptionIds } =
      await this.productService.list(p, {
        keyword: q.keyword,
        type: q.type,
        memberId,
        ownership: q.ownership,
        sort: q.sort,
        media: q.media,
      });
    // PERFORMANCE-tier rate for commisionFixAmount preview. One lookup per request;
    // anon (public list) → tier 1 (20%) default inside the serializer.
    const commissionRate = memberId
      ? await this.affiliatorService.getPerformanceRate(memberId)
      : undefined;
    const items = rows.map((r) =>
      serializeProduct(r, {
        ratingAvg: ratingAvgByProduct.get(r.id) ?? 0,
        isPurchased: purchasedProductIds.has(r.id),
        viaSubscription: viaSubscriptionIds.has(r.id),
        commissionRate,
      }),
    );
    return okPaginated(res, items, { page: p.page, perPage: p.perPage, total });
  };

  @ApiOperation({ summary: 'Course product detail' })
  @ApiQuery({ name: 'code', type: 'string', required: true, example: 'react-fundamentals' })
  @ApiResponse({ status: 200, type: () => CourseDetailDto })
  courseDetail = async (req: Request, res: Response) => {
    const code = (req.query.code as string) ?? '';
    if (!code) throw new BadRequestException('code required');
    const { product, reviewAggregate } = await this.productService.courseDetail(code);
    const memberId = (req as { user?: { id?: string } }).user?.id;
    let affiliateCode: string | null = null;
    let isPurchase = false;
    let viaSubscription = false;
    if (memberId) {
      const m = await prisma.member.findUnique({
        where: { id: memberId },
        select: { affiliateCode: true },
      });
      affiliateCode = m?.affiliateCode ?? null;
      if (product.course) {
        // Valid enrollment (retail by existence, lazy row by date — BE-06
        // predicate) OR an active subscription = "owned" (BE-11).
        // viaSubscription marks access that exists ONLY because of the sub —
        // a valid RETAIL enrollment wins (lifetime beats borrowed access).
        const enrollment = await prisma.courseEnrollment.findUnique({
          where: { memberId_courseId: { memberId, courseId: product.course.id } },
          select: { viaSubscriptionId: true, expiredDate: true },
        });
        const validEnrollment =
          enrollment != null && this.entitlement.isEnrollmentValid(enrollment);
        const validRetail = validEnrollment && enrollment!.viaSubscriptionId === null;
        isPurchase =
          validEnrollment || (await this.entitlement.hasActiveSubscription(memberId));
        viaSubscription = isPurchase && !validRetail;
      }
    }
    return ok(
      res,
      serializeCourseDetailLegacy(product, reviewAggregate, {
        affiliateCode,
        isPurchase,
        viaSubscription,
      }),
    );
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Generate a share link for a course' })
  @ApiResponse({ status: 200, type: () => ProductShareDto })
  shareCourse = async (req: Request, res: Response) => {
    const code = (req.body?.code as string) ?? '';
    if (!code) throw new BadRequestException('code required');
    const product = await prisma.product.findUnique({
      where: { code },
      select: { id: true, code: true, slug: true, title: true, marketingLink: true },
    });
    if (!product) throw new BadRequestException(`Product not found: ${code}`);
    const memberId = (req as { user?: { id?: string } }).user?.id;
    let affiliateCode: string | null = null;
    if (memberId) {
      const m = await prisma.member.findUnique({
        where: { id: memberId },
        select: { affiliateCode: true },
      });
      affiliateCode = m?.affiliateCode ?? null;
    }
    const baseUrl = process.env.PUBLIC_WEB_URL ?? 'https://brainboost.com';
    const slug = product.slug ?? product.code ?? product.id;
    const productUrl = product.marketingLink ?? `${baseUrl}/p/${slug}`;
    const shareUrl = affiliateCode ? `${productUrl}?affCode=${affiliateCode}` : productUrl;
    return ok(res, { code: product.code, shareUrl });
  };
}
