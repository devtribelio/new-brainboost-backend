import { Router } from 'express';
import { TopicController } from './topic.controller';
import { TopicService } from './topic.service';
import { authGuard, optionalAuthGuard } from '@bb/common/middlewares/auth.middleware';
import { bindRoute } from '@bb/common/openapi/route-binder';

export function topicRoutes(): Router {
  const router = Router();
  const ctrl = new TopicController(new TopicService());

  bindRoute({
    router,
    controller: ctrl,
    method: 'get',
    path: '/topic/list',
    handlerKey: 'list',
    middlewares: [optionalAuthGuard],
  });
  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/topic/subscribe',
    handlerKey: 'subscribe',
    middlewares: [authGuard],
  });

  return router;
}
