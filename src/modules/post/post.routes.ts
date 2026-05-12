import { Router } from 'express';
import { PostController } from './post.controller';
import { PostService } from './post.service';
import { authGuard } from '@/common/middlewares/auth.middleware';
import { bindRoute } from '@/common/openapi/route-binder';

export function postRoutes(): Router {
  const router = Router();
  const ctrl = new PostController(new PostService());

  bindRoute({ router, controller: ctrl, method: 'get', path: '/post/list', handlerKey: 'list', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'get', path: '/post/detail', handlerKey: 'detail', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/post/like', handlerKey: 'like', middlewares: [authGuard] });
  // POST /post/create handles both create + update (matches legacy API contract)
  bindRoute({ router, controller: ctrl, method: 'post', path: '/post/create', handlerKey: 'upsert', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/post/delete', handlerKey: 'remove', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/post/report', handlerKey: 'report', middlewares: [authGuard] });

  return router;
}
