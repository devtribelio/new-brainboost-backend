import { Router } from 'express';
import { bindRoute } from '@bb/common/openapi/route-binder';
import { validateDto } from '@bb/common/middlewares/validation.middleware';
import { WebhookController } from './webhook.controller';
import { XenditWebhookHandler } from './xendit.handler';
import { RevenueCatWebhookHandler } from './revenuecat.handler';
import { XenditDisbursementWebhookHandler } from './xendit-disbursement.handler';
import { SumsubWebhookHandler } from './sumsub.handler';
import { xenditCallbackGuard } from './xendit-callback.guard';
import { sumsubDigestGuard } from './sumsub-digest.guard';
import { revenueCatCallbackGuard } from './revenuecat-callback.guard';
import { XenditInvoiceCallbackDto } from './dto/xendit-callback.dto';
import { RevenueCatCallbackDto } from './dto/revenuecat-callback.dto';
import { XenditDisbursementCallbackDto } from './dto/xendit-disbursement-callback.dto';

export function webhookRoutes(): Router {
  const router = Router();
  const ctrl = new WebhookController(
    new XenditWebhookHandler(),
    new RevenueCatWebhookHandler(),
    new XenditDisbursementWebhookHandler(),
    new SumsubWebhookHandler(),
  );

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

  // Xendit Disbursement callback — affiliate payout result (COMPLETED / FAILED).
  // Same callback-token guard as the invoice webhook (X-Callback-Token).
  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/xendit/disbursement',
    handlerKey: 'xenditDisbursementCallback',
    middlewares: [xenditCallbackGuard, validateDto(XenditDisbursementCallbackDto)],
  });

  // Sumsub KYC webhook — HMAC digest over the raw body (x-payload-digest).
  // No validateDto: Sumsub sends 20+ event shapes; the handler switches on `type`.
  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/sumsub',
    handlerKey: 'sumsubWebhook',
    middlewares: [sumsubDigestGuard],
  });

  return router;
}
