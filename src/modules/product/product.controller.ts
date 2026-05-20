import type { Request, Response } from 'express';
import { ProductService } from './product.service';
import { ok, okPaginated } from '@/common/utils/response.util';
import { BadRequestException } from '@/common/exceptions';
import { parsePagination } from '@/common/utils/pagination.util';
import { serializeProduct, serializeCourseDetailLegacy } from './product.serializer';
import { prisma } from '@/config/prisma';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@/common/openapi/decorators';
import { CourseDetailDto, ProductDto, ProductShareDto } from './dto/product.dto';

@ApiTags('Product')
export class ProductController {
  constructor(private readonly productService: ProductService) {}

  @ApiOperation({ summary: 'List products' })
  @ApiQuery({ name: 'page', type: 'integer', required: false, example: 1 })
  @ApiQuery({ name: 'perPage', type: 'integer', required: false, example: 100 })
  @ApiQuery({ name: 'keyword', type: 'string', required: false, example: 'react' })
  @ApiQuery({ name: 'type', type: 'string', required: false, example: 'course' })
  @ApiResponse({
    status: 200,
    type: () => ProductDto,
    isArray: true,
    envelope: 'paginated',
  })
  list = async (req: Request, res: Response) => {
    const p = parsePagination(req.query as Record<string, unknown>, { perPage: 100 });
    const keyword = (req.query.keyword as string) ?? undefined;
    const type = (req.query.type as string) ?? undefined;
    const memberId = (req as { user?: { id?: string } }).user?.id;
    const { rows, total, ratingAvgByProduct, purchasedProductIds } = await this.productService.list(
      p,
      { keyword, type, memberId },
    );
    const items = rows.map((r) =>
      serializeProduct(r, {
        ratingAvg: ratingAvgByProduct.get(r.id) ?? 0,
        isPurchased: purchasedProductIds.has(r.id),
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
    if (memberId) {
      const m = await prisma.member.findUnique({
        where: { id: memberId },
        select: { affiliateCode: true },
      });
      affiliateCode = m?.affiliateCode ?? null;
      if (product.course) {
        const enrollment = await prisma.courseEnrollment.findUnique({
          where: { memberId_courseId: { memberId, courseId: product.course.id } },
          select: { id: true },
        });
        isPurchase = !!enrollment;
      }
    }
    return ok(
      res,
      serializeCourseDetailLegacy(product, reviewAggregate, { affiliateCode, isPurchase }),
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
