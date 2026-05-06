import { Router } from 'express';
import { ProductController } from './product.controller';
import { ProductService } from './product.service';
import { authGuard } from '@/common/middlewares/auth.middleware';
import { asyncHandler } from '@/common/utils/async-handler';

export function productRoutes(): Router {
  const router = Router();
  const ctrl = new ProductController(new ProductService());

  router.get('/product/list', asyncHandler(ctrl.list));
  router.get('/product/course/detail', asyncHandler(ctrl.courseDetail));
  router.post('/product/course/share', authGuard, asyncHandler(ctrl.shareCourse));

  return router;
}
