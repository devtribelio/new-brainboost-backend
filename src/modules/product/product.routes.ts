import { Router } from 'express';
import { ProductController } from './product.controller';
import { ProductService } from './product.service';
import { authGuard, optionalAuthGuard } from '@/common/middlewares/auth.middleware';
import { bindRoute } from '@/common/openapi/route-binder';

export function productRoutes(): Router {
  const router = Router();
  const ctrl = new ProductController(new ProductService());

  bindRoute({
    router,
    controller: ctrl,
    method: 'get',
    path: '/product/list',
    handlerKey: 'list',
    middlewares: [optionalAuthGuard],
  });
  bindRoute({
    router,
    controller: ctrl,
    method: 'get',
    path: '/product/course/detail',
    handlerKey: 'courseDetail',
    middlewares: [optionalAuthGuard],
  });
  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/product/course/share',
    handlerKey: 'shareCourse',
    middlewares: [authGuard],
  });

  return router;
}
