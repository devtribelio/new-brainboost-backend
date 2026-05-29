import { Router } from 'express';
import { CommentController } from './comment.controller';
import { CommentService } from './comment.service';
import { authGuard, optionalAuthGuard } from '@bb/common/middlewares/auth.middleware';
import { bindRoute } from '@bb/common/openapi/route-binder';

export function commentRoutes(): Router {
  const router = Router();
  const ctrl = new CommentController(new CommentService());

  bindRoute({ router, controller: ctrl, method: 'get', path: '/comment/list', handlerKey: 'list', middlewares: [optionalAuthGuard] });
  bindRoute({ router, controller: ctrl, method: 'get', path: '/comment/detail', handlerKey: 'detail', middlewares: [optionalAuthGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/comment/like', handlerKey: 'like', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/comment/create', handlerKey: 'create', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/comment/update', handlerKey: 'update', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/comment/delete', handlerKey: 'remove', middlewares: [authGuard] });

  return router;
}
