import { Router } from 'express';
import { ProductController } from './product.controller';
import { ProductService } from './product.service';
import { authGuard, optionalAuthGuard } from '@/common/middlewares/auth.middleware';
import { bindRoute } from '@/common/openapi/route-binder';
import { validateDto } from '@/common/middlewares/validation.middleware';
import { ListProductsQueryDto } from './dto/list-query.dto';

export function productRoutes(): Router {
  const router = Router();
  const ctrl = new ProductController(new ProductService());

  bindRoute({
    router,
    controller: ctrl,
    method: 'get',
    path: '/product/list',
    handlerKey: 'list',
    middlewares: [authGuard, validateDto(ListProductsQueryDto, 'query')],
  });
  bindRoute({
    router,
    controller: ctrl,
    method: 'get',
    path: '/product/course/detail',
    handlerKey: 'courseDetail',
    middlewares: [authGuard],
  });
  bindRoute({
    router,
    controller: ctrl,
    method: 'get',
    path: '/product/list/public',
    handlerKey: 'list',
    middlewares: [optionalAuthGuard, validateDto(ListProductsQueryDto, 'query')],
  });
  bindRoute({
    router,
    controller: ctrl,
    method: 'get',
    path: '/product/course/detail/public',
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
