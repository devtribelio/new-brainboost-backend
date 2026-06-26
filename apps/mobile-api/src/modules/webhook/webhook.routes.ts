import { Router } from 'express';
import { bindRoute } from '@bb/common/openapi/route-binder';
import { validateDto } from '@bb/common/middlewares/validation.middleware';
import { WebhookController } from './webhook.controller';
import { XenditWebhookHandler } from './xendit.handler';
import { RevenueCatWebhookHandler } from './revenuecat.handler';
import { XenditDisbursementWebhookHandler } from './xendit-disbursement.handler';
import { DiditWebhookHandler } from './didit.handler';
import { xenditCallbackGuard } from './xendit-callback.guard';
import { diditSignatureGuard } from './didit-signature.guard';
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
    new DiditWebhookHandler(),
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

  // Didit KYC webhook — HMAC-SHA256 over the raw body (X-Signature) + X-Timestamp
  // replay guard. No validateDto: Didit sends several status shapes; the handler
  // switches on `status`.
  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/didit',
    handlerKey: 'diditWebhook',
    middlewares: [diditSignatureGuard],
  });

  return router;
}
