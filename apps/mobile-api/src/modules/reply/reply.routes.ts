import { Router } from 'express';
import { ReplyController } from './reply.controller';
import { ReplyService } from './reply.service';
import { optionalAuthGuard } from '@bb/common/middlewares/auth.middleware';
import { bindRoute } from '@bb/common/openapi/route-binder';

export function replyRoutes(): Router {
  const router = Router();
  const ctrl = new ReplyController(new ReplyService());

  bindRoute({ router, controller: ctrl, method: 'get', path: '/reply/list', handlerKey: 'list', middlewares: [optionalAuthGuard] });

  return router;
}
