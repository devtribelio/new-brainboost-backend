import { Router } from 'express';
import { bindRoute } from '@bb/common/openapi/route-binder';
import { validateDto } from '@bb/common/middlewares/validation.middleware';
import { WebhookController } from './webhook.controller';
import { XenditWebhookHandler } from './xendit.handler';
import { RevenueCatWebhookHandler } from './revenuecat.handler';
import { xenditCallbackGuard } from './xendit-callback.guard';
import { revenueCatCallbackGuard } from './revenuecat-callback.guard';
import { XenditInvoiceCallbackDto } from './dto/xendit-callback.dto';
import { RevenueCatCallbackDto } from './dto/revenuecat-callback.dto';

export function webhookRoutes(): Router {
  const router = Router();
  const ctrl = new WebhookController(new XenditWebhookHandler(), new RevenueCatWebhookHandler());

  // Xendit Invoice callback — Invoice API hosted checkout flow.
  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/xendit/invoice',
    handlerKey: 'xenditInvoice',
    middlewares: [xenditCallbackGuard, validateDto(XenditInvoiceCallbackDto)],
  });

  // RevenueCat webhook — IAP purchases/refunds. Auth via shared-secret header.
  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/revenuecat',
    handlerKey: 'revenuecatWebhook',
    middlewares: [revenueCatCallbackGuard, validateDto(RevenueCatCallbackDto)],
  });

  return router;
}
