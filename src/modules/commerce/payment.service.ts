import { prisma } from '@/config/prisma';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@/common/exceptions';
import { commerceEvents } from '@/common/events/commerce-events';
import { xenditService, type IXenditService } from '@/common/services/xendit.service';
import { computeExpiry } from './utils/compute-expiry';
import { resolveFee } from './utils/fee-preview';
import type { PayDto } from './dto/pay.dto';

export interface CreatePaymentResult {
  paymentId: string;
  paymentStatus: 'PENDING' | 'SUCCESS' | 'EXPIRED' | 'FAILED' | 'CANCELED';
  transactionStatus: 'PENDING' | 'PAID' | 'EXPIRED' | 'FAILED' | 'CANCELED' | 'REFUNDED';
  vaNumber?: string | null;
  bank?: string | null;
  ewalletType?: string | null;
  redirectUrl?: string | null;
  deeplinkUrl?: string | null;
  qrString?: string | null;
  expiredAt?: Date | null;
  amount: number;
  fee: number;
}

export class PaymentService {
  constructor(private readonly xendit: IXenditService = xenditService) {}

  async create(memberId: string, dto: PayDto): Promise<CreatePaymentResult> {
    const tx = await prisma.commerceTransaction.findUnique({
      where: { id: dto.transactionId },
    });
    if (!tx) throw new NotFoundException('Transaction not found');
    if (tx.memberId !== memberId) throw new ForbiddenException('Not your transaction');
    if (tx.status !== 'PENDING') throw new BadRequestException(`Transaction is ${tx.status}`);
    if (tx.expiredAt && tx.expiredAt <= new Date()) {
      throw new BadRequestException('Transaction expired');
    }

    if (dto.paymentType === 'voucher') {
      if (tx.amount !== 0) {
        throw new BadRequestException('Voucher payment requires amount=0');
      }
      return this.completeVoucherBypass(tx.id, memberId, tx.amount, tx);
    }

    if (dto.paymentType === 'cc' && !dto.cardTokenId) {
      throw new BadRequestException('cardTokenId required for cc');
    }
    if (dto.paymentType === 'va' && !dto.bank) {
      throw new BadRequestException('bank required for va');
    }
    if (dto.paymentType === 'eWallet' && !dto.ewalletType) {
      throw new BadRequestException('ewalletType required for eWallet');
    }

    const fee = resolveFee(dto.paymentType, { bank: dto.bank, ewalletType: dto.ewalletType });
    const chargeAmount = tx.amount + fee;

    if (dto.paymentType === 'cc') return this.dispatchCc(tx, memberId, dto, fee, chargeAmount);
    if (dto.paymentType === 'va') return this.dispatchVa(tx, memberId, dto, fee, chargeAmount);
    if (dto.paymentType === 'eWallet') {
      return this.dispatchEwallet(tx, memberId, dto, fee, chargeAmount);
    }
    throw new BadRequestException(`Unsupported paymentType: ${dto.paymentType}`);
  }

  private async dispatchCc(
    tx: TransactionRow,
    memberId: string,
    dto: PayDto,
    fee: number,
    chargeAmount: number,
  ): Promise<CreatePaymentResult> {
    const externalId = this.xendit.generateExternalId();
    const result = await this.xendit.createCardCharge({
      tokenId: dto.cardTokenId!,
      authenticationId: dto.authenticationId,
      amount: chargeAmount,
      externalId,
    });

    const persisted = await prisma.$transaction(async (txdb) => {
      const payment = await txdb.commercePayment.create({
        data: {
          transactionId: tx.id,
          memberId,
          paymentType: 'cc',
          amount: chargeAmount,
          fee,
          acceptedAmount: result.status === 'SUCCESS' ? chargeAmount : 0,
          status: result.status,
          vendorStatus: String((result.raw as Record<string, unknown>)?.status ?? ''),
          externalId,
          xenditId: result.id,
          cardTokenId: dto.cardTokenId,
          cardMaskedNumber: result.maskedCardNumber,
          cardBrand: result.cardBrand,
          logRequest: { tokenId: dto.cardTokenId, amount: chargeAmount },
          logResponse: result.raw as object,
          paidAt: result.status === 'SUCCESS' ? new Date() : null,
        },
      });
      await txdb.commercePaymentEvent.create({
        data: { paymentId: payment.id, source: 'checkout', toStatus: result.status },
      });
      let txStatus = tx.status;
      if (result.status === 'SUCCESS') {
        const updated = await txdb.commerceTransaction.update({
          where: { id: tx.id },
          data: { status: 'PAID', paidAt: new Date(), feeTotal: fee, amount: chargeAmount },
        });
        txStatus = updated.status;
      } else if (result.status === 'FAILED') {
        // tx remains PENDING — user can retry with different card/payment type
      }
      return { payment, txStatus };
    });

    if (result.status === 'SUCCESS') {
      commerceEvents.emit('commerce.payment.success', {
        paymentId: persisted.payment.id,
        transactionId: tx.id,
        memberId,
        productId: tx.productId,
        amount: chargeAmount,
        voucherAmount: tx.voucherAmount,
        voucherId: tx.voucherId,
        affiliatorId: tx.affiliatorId,
        programId: tx.programId,
      });
    } else if (result.status === 'FAILED') {
      commerceEvents.emit('commerce.payment.failed', {
        paymentId: persisted.payment.id,
        transactionId: tx.id,
        reason: result.failureReason,
      });
    }

    return {
      paymentId: persisted.payment.id,
      paymentStatus: result.status,
      transactionStatus: persisted.txStatus,
      amount: chargeAmount,
      fee,
    };
  }

  private async dispatchVa(
    tx: TransactionRow,
    memberId: string,
    dto: PayDto,
    fee: number,
    chargeAmount: number,
  ): Promise<CreatePaymentResult> {
    // Cancel previously-active VA for the same transaction (legacy parity)
    const existingActive = await prisma.commercePayment.findFirst({
      where: {
        transactionId: tx.id,
        paymentType: 'va',
        status: 'PENDING',
        xenditVaId: { not: null },
      },
    });
    if (existingActive?.xenditVaId) {
      try {
        await this.xendit.cancelVa(existingActive.xenditVaId);
      } catch (e) {
        const errCode = (e as { errorCode?: string }).errorCode;
        if (errCode && errCode !== 'INACTIVE_VIRTUAL_ACCOUNT_ERROR') throw e;
      }
      await prisma.commercePayment.update({
        where: { id: existingActive.id },
        data: { status: 'CANCELED' },
      });
    }

    const externalId = this.xendit.generateExternalId();
    const expiredAt = computeExpiry('va')!;
    const member = await prisma.member.findUnique({
      where: { id: memberId },
      select: { fullName: true, email: true },
    });

    const result = await this.xendit.createCallbackVa({
      bank: dto.bank!.toUpperCase(),
      amount: chargeAmount,
      externalId,
      expiredAt,
      memberName: member?.fullName ?? member?.email ?? 'Customer',
    });

    const payment = await prisma.$transaction(async (txdb) => {
      const p = await txdb.commercePayment.create({
        data: {
          transactionId: tx.id,
          memberId,
          paymentType: 'va',
          bank: dto.bank!.toUpperCase(),
          amount: chargeAmount,
          fee,
          status: 'PENDING',
          externalId,
          xenditId: result.id,
          xenditVaId: result.id,
          vaNumber: result.accountNumber,
          expiredAt,
          logRequest: { bank: dto.bank, amount: chargeAmount },
          logResponse: result.raw as object,
        },
      });
      await txdb.commercePaymentEvent.create({
        data: { paymentId: p.id, source: 'checkout', toStatus: 'PENDING' },
      });
      await txdb.commerceTransaction.update({
        where: { id: tx.id },
        data: { feeTotal: fee, amount: chargeAmount },
      });
      return p;
    });

    return {
      paymentId: payment.id,
      paymentStatus: 'PENDING',
      transactionStatus: 'PENDING',
      bank: dto.bank!.toUpperCase(),
      vaNumber: result.accountNumber,
      expiredAt,
      amount: chargeAmount,
      fee,
    };
  }

  private async dispatchEwallet(
    tx: TransactionRow,
    memberId: string,
    dto: PayDto,
    fee: number,
    chargeAmount: number,
  ): Promise<CreatePaymentResult> {
    const ewalletType = dto.ewalletType!.toUpperCase();
    const externalId = this.xendit.generateExternalId();
    const expiredAt = computeExpiry('eWallet', ewalletType)!;

    const result = await this.xendit.createEwalletCharge({
      ewalletType,
      phone: dto.ewalletPhone,
      amount: chargeAmount,
      externalId,
      expiredAt,
    });

    const payment = await prisma.$transaction(async (txdb) => {
      const p = await txdb.commercePayment.create({
        data: {
          transactionId: tx.id,
          memberId,
          paymentType: 'eWallet',
          ewalletType,
          amount: chargeAmount,
          fee,
          status: result.status,
          vendorStatus: String((result.raw as Record<string, unknown>)?.status ?? ''),
          externalId,
          xenditId: result.id,
          expiredAt,
          logRequest: { ewalletType, phone: dto.ewalletPhone, amount: chargeAmount },
          logResponse: result.raw as object,
          paidAt: result.status === 'SUCCESS' ? new Date() : null,
        },
      });
      await txdb.commercePaymentEvent.create({
        data: { paymentId: p.id, source: 'checkout', toStatus: result.status },
      });
      let txStatus = tx.status;
      if (result.status === 'SUCCESS') {
        const updated = await txdb.commerceTransaction.update({
          where: { id: tx.id },
          data: { status: 'PAID', paidAt: new Date(), feeTotal: fee, amount: chargeAmount },
        });
        txStatus = updated.status;
      } else {
        await txdb.commerceTransaction.update({
          where: { id: tx.id },
          data: { feeTotal: fee, amount: chargeAmount },
        });
      }
      return { p, txStatus };
    });

    if (result.status === 'SUCCESS') {
      commerceEvents.emit('commerce.payment.success', {
        paymentId: payment.p.id,
        transactionId: tx.id,
        memberId,
        productId: tx.productId,
        amount: chargeAmount,
        voucherAmount: tx.voucherAmount,
        voucherId: tx.voucherId,
        affiliatorId: tx.affiliatorId,
        programId: tx.programId,
      });
    }

    return {
      paymentId: payment.p.id,
      paymentStatus: result.status,
      transactionStatus: payment.txStatus,
      ewalletType,
      redirectUrl: result.checkoutUrl,
      deeplinkUrl: result.deeplinkUrl,
      qrString: result.qrString,
      expiredAt,
      amount: chargeAmount,
      fee,
    };
  }

  private async completeVoucherBypass(
    transactionId: string,
    memberId: string,
    amount: number,
    tx: TransactionRow,
  ): Promise<CreatePaymentResult> {
    const expiredAt = computeExpiry('voucher');
    const externalId = this.xendit.generateExternalId();
    const result = await prisma.$transaction(async (txdb) => {
      const payment = await txdb.commercePayment.create({
        data: {
          transactionId,
          memberId,
          paymentType: 'voucher',
          amount,
          acceptedAmount: amount,
          status: 'SUCCESS',
          externalId,
          paidAt: new Date(),
          expiredAt,
        },
      });
      await txdb.commercePaymentEvent.create({
        data: { paymentId: payment.id, source: 'checkout', toStatus: 'SUCCESS' },
      });
      const updated = await txdb.commerceTransaction.update({
        where: { id: transactionId },
        data: { status: 'PAID', paidAt: new Date() },
      });
      return { payment, tx: updated };
    });

    commerceEvents.emit('commerce.payment.success', {
      paymentId: result.payment.id,
      transactionId: result.tx.id,
      memberId,
      productId: result.tx.productId,
      amount: result.tx.amount,
      voucherAmount: result.tx.voucherAmount,
      voucherId: result.tx.voucherId,
      affiliatorId: tx.affiliatorId,
      programId: tx.programId,
    });

    return {
      paymentId: result.payment.id,
      paymentStatus: 'SUCCESS',
      transactionStatus: 'PAID',
      amount,
      fee: 0,
    };
  }

  async getTransactionStatus(memberId: string, transactionId: string) {
    const tx = await prisma.commerceTransaction.findUnique({
      where: { id: transactionId },
      include: {
        product: { select: { id: true, title: true, thumbnail: true } },
        payments: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    if (!tx) throw new NotFoundException('Transaction not found');
    if (tx.memberId !== memberId) throw new ForbiddenException('Not your transaction');
    return tx;
  }

  async listTransactions(memberId: string, page = 1, perPage = 20) {
    const [rows, total] = await Promise.all([
      prisma.commerceTransaction.findMany({
        where: { memberId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
        include: { product: { select: { id: true, title: true, thumbnail: true } } },
      }),
      prisma.commerceTransaction.count({ where: { memberId } }),
    ]);
    return { rows, total };
  }

  async cancel(memberId: string, transactionId: string) {
    const tx = await prisma.commerceTransaction.findUnique({
      where: { id: transactionId },
      include: {
        payments: { where: { status: 'PENDING', xenditVaId: { not: null } } },
      },
    });
    if (!tx) throw new NotFoundException('Transaction not found');
    if (tx.memberId !== memberId) throw new ForbiddenException('Not your transaction');
    if (tx.status !== 'PENDING') {
      throw new BadRequestException(`Cannot cancel transaction in ${tx.status} state`);
    }
    for (const pending of tx.payments) {
      if (pending.xenditVaId) {
        try {
          await this.xendit.cancelVa(pending.xenditVaId);
        } catch (e) {
          const errCode = (e as { errorCode?: string }).errorCode;
          if (errCode && errCode !== 'INACTIVE_VIRTUAL_ACCOUNT_ERROR') throw e;
        }
      }
      await prisma.commercePayment.update({
        where: { id: pending.id },
        data: { status: 'CANCELED' },
      });
    }
    return prisma.commerceTransaction.update({
      where: { id: transactionId },
      data: { status: 'CANCELED', canceledAt: new Date() },
    });
  }
}

type TransactionRow = {
  id: string;
  status: 'PENDING' | 'PAID' | 'EXPIRED' | 'FAILED' | 'CANCELED' | 'REFUNDED';
  memberId: string;
  productId: string;
  amount: number;
  voucherAmount: number;
  voucherId: string | null;
  affiliatorId: string | null;
  programId: string | null;
};
