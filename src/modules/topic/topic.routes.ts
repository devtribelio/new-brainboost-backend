import { Router } from 'express';
import { TopicController } from './topic.controller';
import { TopicService } from './topic.service';
import { authGuard } from '@/common/middlewares/auth.middleware';
import { asyncHandler } from '@/common/utils/async-handler';

export function topicRoutes(): Router {
  const router = Router();
  const ctrl = new TopicController(new TopicService());

  router.get('/topic/list', asyncHandler(ctrl.list));
  router.post('/topic/subscribe', authGuard, asyncHandler(ctrl.subscribe));

  return router;
}
