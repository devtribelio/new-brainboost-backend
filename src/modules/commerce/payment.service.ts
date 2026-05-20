import { prisma } from '@/config/prisma';
import { logger } from '@/config/logger';
import { env } from '@/config/env';
import { BadRequestException, ForbiddenException, NotFoundException } from '@/common/exceptions';
import { commerceEvents } from '@/common/events/commerce-events';
import { xenditGateway, type XenditGateway } from '@/common/services/xendit-gateway';
import { generateExternalId } from '@/common/services/xendit-signature';
import type { CreateInvoiceRequest } from 'xendit-node/invoice/models';
import type { PayDto } from './dto/pay.dto';
import type { CommercePaymentStatus, CommerceTransactionStatus } from '@prisma/client';

export interface CreatePaymentResult {
  paymentId: string;
  paymentStatus: CommercePaymentStatus;
  transactionStatus: CommerceTransactionStatus;
  invoiceUrl?: string | null;
  expiredAt?: Date | null;
  amount: number;
  fee: number;
}

type TransactionRow = {
  id: string;
  status: CommerceTransactionStatus;
  memberId: string;
  productId: string;
  amount: number;
  voucherAmount: number;
  voucherId: string | null;
  affiliatorId: string | null;
  programId: string | null;
};

export class PaymentService {
  constructor(private readonly xendit: XenditGateway = xenditGateway) {}

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

    if (tx.amount === 0) {
      return this.completeVoucherBypass(memberId, tx);
    }
    return this.dispatchInvoice(memberId, tx);
  }

  // ============================================================
  // Xendit Invoice (hosted checkout — mobile WebView)
  // ============================================================

  private async dispatchInvoice(
    memberId: string,
    tx: TransactionRow,
  ): Promise<CreatePaymentResult> {
    const externalId = generateExternalId();
    const expiredAt = new Date(Date.now() + env.commerce.invoiceExpiryHours * 60 * 60 * 1000);
    const member = await prisma.member.findUnique({
      where: { id: memberId },
      select: { email: true, fullName: true },
    });

    const params: CreateInvoiceRequest = {
      externalId,
      amount: tx.amount,
      currency: 'IDR',
      payerEmail: member?.email ?? undefined,
      description: `Commerce ${tx.id}`,
      successRedirectUrl: `${env.xendit.invoiceSuccessUrl}?transactionId=${tx.id}`,
      failureRedirectUrl: `${env.xendit.invoiceFailureUrl}?transactionId=${tx.id}`,
      invoiceDuration: env.commerce.invoiceExpiryHours * 60 * 60,
      customer: member?.fullName
        ? {
            givenNames: member.fullName,
            email: member.email ?? undefined,
          }
        : undefined,
      metadata: { transactionId: tx.id, memberId },
    };

    const result = await this.xendit.createInvoice(params);

    const payment = await prisma.$transaction(async (txdb) => {
      const p = await txdb.commercePayment.create({
        data: {
          transactionId: tx.id,
          memberId,
          paymentType: 'invoice',
          amount: tx.amount,
          fee: 0,
          status: 'PENDING',
          externalId,
          xenditId: result.id ?? null,
          checkoutUrl: result.invoiceUrl ?? null,
          expiredAt,
          logRequest: params as unknown as object,
          logResponse: result as unknown as object,
        },
      });
      await txdb.commercePaymentEvent.create({
        data: { paymentId: p.id, source: 'checkout', toStatus: 'PENDING' },
      });
      return p;
    });

    return {
      paymentId: payment.id,
      paymentStatus: 'PENDING',
      transactionStatus: 'PENDING',
      invoiceUrl: result.invoiceUrl,
      expiredAt,
      amount: tx.amount,
      fee: 0,
    };
  }

  // ============================================================
  // Voucher 100% bypass (no Xendit call)
  // ============================================================

  private async completeVoucherBypass(
    memberId: string,
    tx: TransactionRow,
  ): Promise<CreatePaymentResult> {
    const externalId = generateExternalId();
    const result = await prisma.$transaction(async (txdb) => {
      const payment = await txdb.commercePayment.create({
        data: {
          transactionId: tx.id,
          memberId,
          paymentType: 'voucher',
          amount: 0,
          acceptedAmount: 0,
          status: 'SUCCESS',
          externalId,
          paidAt: new Date(),
        },
      });
      await txdb.commercePaymentEvent.create({
        data: { paymentId: payment.id, source: 'checkout', toStatus: 'SUCCESS' },
      });
      const updated = await txdb.commerceTransaction.update({
        where: { id: tx.id },
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
      amount: 0,
      fee: 0,
    };
  }

  // ============================================================
  // Read / list / cancel
  // ============================================================

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
    const latest = tx.payments[0];
    return {
      transactionId: tx.id,
      transactionCode: tx.code,
      status: tx.status,
      amount: tx.amount,
      expiredAt: tx.expiredAt,
      paidAt: tx.paidAt,
      canceledAt: tx.canceledAt,
      activePayment: latest
        ? {
            paymentId: latest.id,
            paymentType: latest.paymentType,
            status: latest.status,
            invoiceUrl: latest.checkoutUrl,
            expiredAt: latest.expiredAt,
          }
        : null,
      product: tx.product,
    };
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
        payments: { where: { status: 'PENDING', xenditId: { not: null } } },
      },
    });
    if (!tx) throw new NotFoundException('Transaction not found');
    if (tx.memberId !== memberId) throw new ForbiddenException('Not your transaction');
    if (tx.status !== 'PENDING') {
      throw new BadRequestException(`Cannot cancel transaction in ${tx.status} state`);
    }
    for (const pending of tx.payments) {
      if (pending.xenditId) {
        try {
          await this.xendit.expireInvoice(pending.xenditId);
        } catch (e) {
          logger.warn(
            { paymentId: pending.id, invoiceId: pending.xenditId, err: (e as Error).message },
            '[commerce.cancel] xendit expireInvoice failed; proceeding with local cancel',
          );
        }
      }
      await prisma.$transaction([
        prisma.commercePayment.update({
          where: { id: pending.id },
          data: { status: 'CANCELED' },
        }),
        prisma.commercePaymentEvent.create({
          data: {
            paymentId: pending.id,
            source: 'manual',
            fromStatus: pending.status,
            toStatus: 'CANCELED',
          },
        }),
      ]);
    }
    return prisma.commerceTransaction.update({
      where: { id: transactionId },
      data: { status: 'CANCELED', canceledAt: new Date() },
    });
  }
}

// ============================================================
// Status mapping helpers
// ============================================================

/**
 * Map Xendit Invoice status → internal CommercePaymentStatus.
 * Invoice states: PENDING | PAID | SETTLED | EXPIRED.
 */
export function mapInvoiceStatus(status: string | undefined): CommercePaymentStatus {
  const raw = String(status ?? '').toUpperCase();
  if (raw === 'PAID' || raw === 'SETTLED' || raw === 'COMPLETED' || raw === 'SUCCESS') {
    return 'SUCCESS';
  }
  if (raw === 'EXPIRED') return 'EXPIRED';
  if (raw === 'FAILED') return 'FAILED';
  if (raw === 'CANCELED' || raw === 'STOPPED') return 'CANCELED';
  return 'PENDING';
}
