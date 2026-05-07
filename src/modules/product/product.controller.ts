import type { Request, Response } from 'express';
import { ProductService } from './product.service';
import { ok } from '@/common/utils/response.util';
import { BadRequestException } from '@/common/exceptions';
import { buildLegacyPage, parsePagination } from '@/common/utils/pagination.util';
import { serializeProduct } from '@/common/serializers';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@/common/openapi/decorators';

@ApiTags('Product')
export class ProductController {
  constructor(private readonly productService: ProductService) {}

  @ApiOperation({ summary: 'List products' })
  @ApiQuery({ name: 'page', type: 'integer', required: false })
  @ApiQuery({ name: 'perPage', type: 'integer', required: false })
  @ApiQuery({ name: 'keyword', type: 'string', required: false })
  @ApiQuery({ name: 'type', type: 'string', required: false })
  @ApiResponse({ status: 200 })
  list = async (req: Request, res: Response) => {
    const p = parsePagination(req.query as Record<string, unknown>);
    const keyword = (req.query.keyword as string) ?? undefined;
    const type = (req.query.type as string) ?? undefined;
    const { rows, total } = await this.productService.list(p, { keyword, type });
    return ok(res, buildLegacyPage(rows.map(serializeProduct), total, p));
  };

  @ApiOperation({ summary: 'Course product detail' })
  @ApiQuery({ name: 'productId', type: 'string', required: true })
  @ApiResponse({ status: 200 })
  courseDetail = async (req: Request, res: Response) => {
    const productId = (req.query.productId as string) ?? '';
    if (!productId) throw new BadRequestException('productId required');
    const product = await this.productService.courseDetail(productId);
    return ok(res, {
      ...serializeProduct(product),
      course: product.course
        ? {
            id: product.course.id,
            durationMin: product.course.durationMin,
            level: product.course.level,
            contentRef: product.course.contentRef,
          }
        : null,
    });
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Generate a share link for a course' })
  @ApiResponse({ status: 200 })
  shareCourse = async (req: Request, res: Response) => {
    const productId = (req.body?.productId as string) ?? '';
    if (!productId) throw new BadRequestException('productId required');
    return ok(res, { productId, shareUrl: `https://share.example.com/course/${productId}` });
  };
}
