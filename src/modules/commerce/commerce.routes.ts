import { Router } from 'express';
import { authGuard } from '@/common/middlewares/auth.middleware';
import { bindRoute } from '@/common/openapi/route-binder';
import { validateDto } from '@/common/middlewares/validation.middleware';
import { CommerceController } from './commerce.controller';
import { CheckoutService } from './checkout.service';
import { PaymentService } from './payment.service';
import { VoucherService } from './voucher.service';
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
    middlewares: [authGuard, validateDto(ValidateVoucherDto)],
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
