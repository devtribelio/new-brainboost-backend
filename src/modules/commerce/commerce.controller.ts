import type { Request, Response } from 'express';
import { ok, okCreated, okPaginated } from '@/common/utils/response.util';
import { parsePagination } from '@/common/utils/pagination.util';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@/common/openapi/decorators';
import type { CheckoutService } from './checkout.service';
import type { PaymentService } from './payment.service';
import type { VoucherService } from './voucher.service';
import { StartCheckoutDto } from './dto/start-checkout.dto';
import { PayDto, CancelTransactionDto, ValidateVoucherDto } from './dto/pay.dto';
import {
  CommerceTransactionListItemDto,
  CreatePaymentResultDto,
  StartCheckoutResultDto,
  TransactionStatusResultDto,
  VoucherValidateResultDto,
} from './dto/response.dto';

interface ReqWithUser extends Request {
  user?: { id: string };
}

@ApiTags('Commerce')
export class CommerceController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly payment: PaymentService,
    private readonly voucher: VoucherService,
  ) {}

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Start checkout — create PENDING transaction' })
  @ApiBody({ type: () => StartCheckoutDto })
  @ApiResponse({ status: 201, type: () => StartCheckoutResultDto })
  startCheckout = async (req: ReqWithUser, res: Response) => {
    const dto = req.body as StartCheckoutDto;
    const result = await this.checkout.start({
      memberId: req.user!.id,
      productId: dto.productId,
      voucherCode: dto.voucherCode,
      affiliatorCode: dto.affiliatorCode,
    });
    return okCreated(res, result);
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create payment for a PENDING transaction' })
  @ApiBody({ type: () => PayDto })
  @ApiResponse({ status: 201, type: () => CreatePaymentResultDto })
  createPayment = async (req: ReqWithUser, res: Response) => {
    const dto = req.body as PayDto;
    const result = await this.payment.create(req.user!.id, dto);
    return okCreated(res, result);
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Poll transaction status + active payment' })
  @ApiResponse({ status: 200, type: () => TransactionStatusResultDto })
  getTransactionStatus = async (req: ReqWithUser, res: Response) => {
    const tx = await this.payment.getTransactionStatus(req.user!.id, req.params.transactionId);
    return ok(res, tx);
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'List commerce transactions (history)' })
  @ApiResponse({
    status: 200,
    type: () => CommerceTransactionListItemDto,
    isArray: true,
    envelope: 'paginated',
  })
  listTransactions = async (req: ReqWithUser, res: Response) => {
    const p = parsePagination(req.query as Record<string, unknown>, { perPage: 20 });
    const { rows, total } = await this.payment.listTransactions(req.user!.id, p.page, p.perPage);
    return okPaginated(res, rows, { page: p.page, perPage: p.perPage, total });
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cancel a PENDING transaction' })
  @ApiBody({ type: () => CancelTransactionDto })
  cancelTransaction = async (req: ReqWithUser, res: Response) => {
    const dto = req.body as CancelTransactionDto;
    const result = await this.payment.cancel(req.user!.id, dto.transactionId);
    return ok(res, result);
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Validate voucher (dry-run, no redeem)' })
  @ApiBody({ type: () => ValidateVoucherDto })
  @ApiResponse({ status: 200, type: () => VoucherValidateResultDto })
  validateVoucher = async (req: ReqWithUser, res: Response) => {
    const dto = req.body as ValidateVoucherDto;
    const result = await this.voucher.validate(dto.code, dto.productId);
    return ok(res, result);
  };
}
