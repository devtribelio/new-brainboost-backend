import { Router } from 'express';
import { bindRoute } from '@/common/openapi/route-binder';
import { WebhookController } from './webhook.controller';
import { XenditWebhookHandler } from './xendit.handler';
import { xenditCallbackGuard } from './xendit-callback.guard';

export function webhookRoutes(): Router {
  const router = Router();
  const ctrl = new WebhookController(new XenditWebhookHandler());

  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/xendit/va',
    handlerKey: 'xenditVa',
    middlewares: [xenditCallbackGuard],
  });
  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/xendit/ewallet',
    handlerKey: 'xenditEwallet',
    middlewares: [xenditCallbackGuard],
  });
  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/xendit/cc',
    handlerKey: 'xenditCc',
    middlewares: [xenditCallbackGuard],
  });

  return router;
}
