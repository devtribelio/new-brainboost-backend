import type { Request, Response } from 'express';
import { ProductService } from './product.service';
import { notImplemented } from '@/common/utils/response.util';

export class ProductController {
  constructor(private readonly _productService: ProductService) {}

  list = async (_req: Request, res: Response) => notImplemented(res, 'product.list');
  courseDetail = async (_req: Request, res: Response) =>
    notImplemented(res, 'product.courseDetail');
  shareCourse = async (_req: Request, res: Response) => notImplemented(res, 'product.shareCourse');
}
