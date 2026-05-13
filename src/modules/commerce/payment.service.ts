import { prisma } from '@/config/prisma';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@/common/exceptions';
import { commerceEvents } from '@/common/events/commerce-events';
import { xenditService } from '@/common/services/xendit.service';
import { computeExpiry } from './utils/compute-expiry';
import type { PayDto } from './dto/pay.dto';

export interface CreatePaymentResult {
  paymentId: string;
  paymentStatus: 'PENDING' | 'SUCCESS' | 'EXPIRED' | 'FAILED' | 'CANCELED';
  transactionStatus: 'PENDING' | 'PAID' | 'EXPIRED' | 'FAILED' | 'CANCELED' | 'REFUNDED';
  vaNumber?: string | null;
  bank?: string | null;
  ewalletType?: string | null;
  redirectUrl?: string | null;
  qrString?: string | null;
  expiredAt?: Date | null;
  amount: number;
}

export class PaymentService {
  /**
   * Create a payment attempt for a PENDING transaction. P3 will wire actual Xendit calls;
   * for now only the voucher-bypass path is fully runnable.
   */
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
      return this.completeVoucherBypass(tx.id, memberId, tx.amount);
    }

    if (dto.paymentType === 'cc') {
      throw new BadRequestException('CC payment not yet implemented (P3)');
    }
    if (dto.paymentType === 'va') {
      throw new BadRequestException('VA payment not yet implemented (P3)');
    }
    if (dto.paymentType === 'eWallet') {
      throw new BadRequestException('eWallet payment not yet implemented (P3)');
    }

    // unreachable thanks to DTO IsIn check, but keeps compiler happy
    throw new BadRequestException(`Unsupported paymentType: ${dto.paymentType}`);
  }

  private async completeVoucherBypass(
    transactionId: string,
    memberId: string,
    amount: number,
  ): Promise<CreatePaymentResult> {
    const expiredAt = computeExpiry('voucher');
    const externalId = xenditService.generateExternalId();
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
        data: {
          paymentId: payment.id,
          source: 'checkout',
          toStatus: 'SUCCESS',
        },
      });
      const tx = await txdb.commerceTransaction.update({
        where: { id: transactionId },
        data: { status: 'PAID', paidAt: new Date() },
      });
      return { payment, tx };
    });

    commerceEvents.emit('commerce.payment.success', {
      paymentId: result.payment.id,
      transactionId: result.tx.id,
      memberId,
      productId: result.tx.productId,
      amount: result.tx.amount,
      voucherAmount: result.tx.voucherAmount,
      voucherId: result.tx.voucherId,
      affiliatorId: result.tx.affiliatorId,
      programId: result.tx.programId,
    });

    return {
      paymentId: result.payment.id,
      paymentStatus: 'SUCCESS',
      transactionStatus: 'PAID',
      amount,
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
    });
    if (!tx) throw new NotFoundException('Transaction not found');
    if (tx.memberId !== memberId) throw new ForbiddenException('Not your transaction');
    if (tx.status !== 'PENDING') {
      throw new BadRequestException(`Cannot cancel transaction in ${tx.status} state`);
    }
    return prisma.commerceTransaction.update({
      where: { id: transactionId },
      data: { status: 'CANCELED', canceledAt: new Date() },
    });
  }
}
