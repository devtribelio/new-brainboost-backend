import type { Request, Response } from 'express';
import { ProductService } from './product.service';
import { ok } from '@/common/utils/response.util';
import { BadRequestException } from '@/common/exceptions';
import { buildLegacyPage, parsePagination } from '@/common/utils/pagination.util';
import { serializeProduct, serializeCourseDetailLegacy } from '@/common/serializers';
import { prisma } from '@/config/prisma';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@/common/openapi/decorators';
import { CourseDetailDto, ProductPageDto, ProductShareDto } from './dto/product.dto';

@ApiTags('Product')
export class ProductController {
  constructor(private readonly productService: ProductService) {}

  @ApiOperation({ summary: 'List products' })
  @ApiQuery({ name: 'page', type: 'integer', required: false, example: 1 })
  @ApiQuery({ name: 'perPage', type: 'integer', required: false, example: 20 })
  @ApiQuery({ name: 'keyword', type: 'string', required: false, example: 'react' })
  @ApiQuery({ name: 'type', type: 'string', required: false, example: 'course' })
  @ApiResponse({ status: 200, type: () => ProductPageDto })
  list = async (req: Request, res: Response) => {
    const p = parsePagination(req.query as Record<string, unknown>);
    const keyword = (req.query.keyword as string) ?? undefined;
    const type = (req.query.type as string) ?? undefined;
    const { rows, total, ratingAvgByProduct } = await this.productService.list(p, {
      keyword,
      type,
    });
    return ok(
      res,
      buildLegacyPage(
        rows.map((r) => serializeProduct(r, { ratingAvg: ratingAvgByProduct.get(r.id) ?? 0 })),
        total,
        p,
      ),
    );
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
    if (memberId) {
      const m = await prisma.member.findUnique({
        where: { id: memberId },
        select: { affiliateCode: true },
      });
      affiliateCode = m?.affiliateCode ?? null;
    }
    return ok(res, serializeCourseDetailLegacy(product, reviewAggregate, { affiliateCode }));
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Generate a share link for a course' })
  @ApiResponse({ status: 200, type: () => ProductShareDto })
  shareCourse = async (req: Request, res: Response) => {
    const productId = (req.body?.productId as string) ?? '';
    if (!productId) throw new BadRequestException('productId required');
    return ok(res, { productId, shareUrl: `https://share.example.com/course/${productId}` });
  };
}
