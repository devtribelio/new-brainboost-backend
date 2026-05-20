import { Router } from 'express';
import { bindRoute } from '@/common/openapi/route-binder';
import { validateDto } from '@/common/middlewares/validation.middleware';
import { WebhookController } from './webhook.controller';
import { XenditWebhookHandler } from './xendit.handler';
import { xenditCallbackGuard } from './xendit-callback.guard';
import { XenditInvoiceCallbackDto } from './dto/xendit-callback.dto';

export function webhookRoutes(): Router {
  const router = Router();
  const ctrl = new WebhookController(new XenditWebhookHandler());

  // Xendit Invoice callback — Invoice API hosted checkout flow.
  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/xendit/invoice',
    handlerKey: 'xenditInvoice',
    middlewares: [xenditCallbackGuard, validateDto(XenditInvoiceCallbackDto)],
  });

  return router;
}
