import { Router } from 'express';
import { ReplyController } from './reply.controller';
import { ReplyService } from './reply.service';
import { asyncHandler } from '@/common/utils/async-handler';

export function replyRoutes(): Router {
  const router = Router();
  const ctrl = new ReplyController(new ReplyService());

  router.get('/reply/list', asyncHandler(ctrl.list));

  return router;
}
