import { Router } from 'express';
import { PostKindController } from './post-kind.controller';
import { PostKindService } from './post-kind.service';
import { optionalAuthGuard } from '@bb/common/middlewares/auth.middleware';
import { bindRoute } from '@bb/common/openapi/route-binder';

export function postKindRoutes(): Router {
  const router = Router();
  const ctrl = new PostKindController(new PostKindService());

  bindRoute({
    router,
    controller: ctrl,
    method: 'get',
    path: '/post-kinds',
    handlerKey: 'list',
    middlewares: [optionalAuthGuard],
  });

  return router;
}
