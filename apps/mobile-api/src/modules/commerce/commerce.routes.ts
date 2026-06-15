import { Router } from 'express';
import { authGuard } from '@bb/common/middlewares/auth.middleware';
import { voucherValidateRateLimiter } from '@bb/common/middlewares/rate-limit.middleware';
import { bindRoute } from '@bb/common/openapi/route-binder';
import { validateDto } from '@bb/common/middlewares/validation.middleware';
import { CommerceController } from './commerce.controller';
import { CheckoutService } from '@bb/domain/commerce/checkout.service';
import { PaymentService } from '@bb/domain/commerce/payment.service';
import { VoucherService } from '@bb/domain/commerce/voucher.service';
import { StartCheckoutDto } from './dto/start-checkout.dto';
import { PayDto, CancelTransactionDto, ValidateVoucherDto } from './dto/pay.dto';
import { ListTransactionsQueryDto } from './dto/list-transactions.dto';

export function commerceRoutes(): Router {
  const router = Router();
  const voucher = new VoucherService();
  const ctrl = new CommerceController(new CheckoutService(voucher), new PaymentService(), voucher);

  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/product/checkout/submit',
    handlerKey: 'startCheckout',
    middlewares: [authGuard, validateDto(StartCheckoutDto)],
  });
  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/payment/commerce',
    handlerKey: 'createPayment',
    middlewares: [authGuard, validateDto(PayDto)],
  });
  bindRoute({
    router,
    controller: ctrl,
    method: 'get',
    path: '/payment/commerce/list',
    handlerKey: 'listTransactions',
    middlewares: [authGuard, validateDto(ListTransactionsQueryDto, 'query')],
  });
  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/payment/commerce/cancel',
    handlerKey: 'cancelTransaction',
    middlewares: [authGuard, validateDto(CancelTransactionDto)],
  });
  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/payment/voucher/validate',
    handlerKey: 'validateVoucher',
    middlewares: [authGuard, voucherValidateRateLimiter, validateDto(ValidateVoucherDto)],
  });
  bindRoute({
    router,
    controller: ctrl,
    method: 'get',
    path: '/payment/commerce/:transactionId',
    handlerKey: 'getTransactionStatus',
    middlewares: [authGuard],
  });

  return router;
}
