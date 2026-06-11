import { Router } from 'express';
import { ProductController } from './product.controller';
import { ProductService } from './product.service';
import { AffiliatorService } from '@bb/domain/affiliate/affiliator.service';
import { authGuard, optionalAuthGuard } from '@bb/common/middlewares/auth.middleware';
import { bindRoute } from '@bb/common/openapi/route-binder';
import { validateDto } from '@bb/common/middlewares/validation.middleware';
import { ListProductsQueryDto } from './dto/list-query.dto';

export function productRoutes(): Router {
  const router = Router();
  const ctrl = new ProductController(new ProductService(), new AffiliatorService());

  bindRoute({
    router,
    controller: ctrl,
    method: 'get',
    path: '/product/list',
    handlerKey: 'list',
    // Guest mode (Apple 5.1.1): catalog browsing must not force login. The
    // handler is already null-user-safe (same one serves /public).
    middlewares: [optionalAuthGuard, validateDto(ListProductsQueryDto, 'query')],
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
