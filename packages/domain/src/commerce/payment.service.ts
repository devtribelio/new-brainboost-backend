import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { env } from '@bb/common/config/env';
import { BadRequestException, ForbiddenException, NotFoundException } from '@bb/common/exceptions';
import { commerceEvents } from '@bb/common/events/commerce-events';
import { xenditGateway, type XenditGateway } from '@bb/common/services/xendit-gateway';
import { generateExternalId } from '@bb/common/services/xendit-signature';
import type { CreateInvoiceRequest } from 'xendit-node/invoice/models';
import { Prisma } from '@prisma/client';
import type { CommercePaymentStatus, CommerceTransactionStatus } from '@prisma/client';

/** Domain input for creating a payment. The HTTP layer's PayDto satisfies this shape. */
export interface CreatePaymentInput {
  transactionId: string;
}

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
  attributedAffiliatorMemberId: string | null;
};

export class PaymentService {
  constructor(private readonly xendit: XenditGateway = xenditGateway) {}

  async create(memberId: string, dto: CreatePaymentInput): Promise<CreatePaymentResult> {
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

    // 1. Claim the transaction's active slot BEFORE the (expensive, non-idempotent) Xendit
    //    call. The `activeSlotTxId` unique index serializes concurrent checkouts so only the
    //    winner creates an invoice — a loser gets P2002 and returns the existing payment.
    let payment: { id: string };
    try {
      payment = await prisma.commercePayment.create({
        data: {
          transactionId: tx.id,
          memberId,
          paymentType: 'invoice',
          amount: tx.amount,
          fee: 0,
          status: 'PENDING',
          externalId,
          expiredAt,
          activeSlotTxId: tx.id,
        },
        select: { id: true },
      });
    } catch (e) {
      if (isActiveSlotConflict(e)) return this.returnExistingActivePayment(tx);
      throw e;
    }

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

    // 2. Only the winner reaches Xendit. On failure, free the slot (mark FAILED) so the
    //    member can retry checkout instead of being permanently blocked by a dead claim.
    let result;
    try {
      result = await this.xendit.createInvoice(params);
    } catch (e) {
      await prisma.commercePayment
        .update({ where: { id: payment.id }, data: { status: 'FAILED', activeSlotTxId: null } })
        .catch((err) =>
          logger.error({ err, paymentId: payment.id }, '[commerce] failed to release slot after Xendit error'),
        );
      throw e;
    }

    // 3. Persist invoice references + audit event onto the already-claimed row.
    await prisma.$transaction(async (txdb) => {
      await txdb.commercePayment.update({
        where: { id: payment.id },
        data: {
          xenditId: result.id ?? null,
          checkoutUrl: result.invoiceUrl ?? null,
          logRequest: params as unknown as object,
          logResponse: result as unknown as object,
        },
      });
      await txdb.commercePaymentEvent.create({
        data: { paymentId: payment.id, source: 'checkout', toStatus: 'PENDING' },
      });
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
    let payment: { id: string };
    try {
      payment = await prisma.$transaction(async (txdb) => {
        const p = await txdb.commercePayment.create({
          data: {
            transactionId: tx.id,
            memberId,
            paymentType: 'voucher',
            amount: 0,
            acceptedAmount: 0,
            status: 'SUCCESS',
            externalId,
            paidAt: new Date(),
            activeSlotTxId: tx.id, // occupy slot — a SUCCESS payment blocks any further payment
          },
          select: { id: true },
        });
        await txdb.commercePaymentEvent.create({
          data: { paymentId: p.id, source: 'checkout', toStatus: 'SUCCESS' },
        });
        // Guard: only settle a still-PENDING transaction. A concurrent settle (webhook /
        // ingest) updates 0 rows → abort and roll back this payment.
        const settled = await txdb.commerceTransaction.updateMany({
          where: { id: tx.id, status: 'PENDING' },
          data: { status: 'PAID', paidAt: new Date() },
        });
        if (settled.count === 0) {
          throw new BadRequestException('Transaction is no longer pending');
        }
        return p;
      });
    } catch (e) {
      if (isActiveSlotConflict(e)) return this.returnExistingActivePayment(tx);
      throw e;
    }

    commerceEvents.emit('commerce.payment.success', {
      paymentId: payment.id,
      transactionId: tx.id,
      memberId,
      productId: tx.productId,
      amount: tx.amount,
      voucherAmount: tx.voucherAmount,
      voucherId: tx.voucherId,
      affiliatorId: tx.affiliatorId,
      programId: tx.programId,
      attributedAffiliatorMemberId: tx.attributedAffiliatorMemberId,
    });

    return {
      paymentId: payment.id,
      paymentStatus: 'SUCCESS',
      transactionStatus: 'PAID',
      amount: 0,
      fee: 0,
    };
  }

  /**
   * A concurrent checkout already holds the transaction's active slot. Return that payment
   * so the caller is idempotent (same invoice URL / status) instead of erroring.
   */
  private async returnExistingActivePayment(tx: TransactionRow): Promise<CreatePaymentResult> {
    const existing = await prisma.commercePayment.findFirst({
      where: { transactionId: tx.id, activeSlotTxId: tx.id },
      orderBy: { createdAt: 'desc' },
    });
    if (!existing) {
      // Slot was freed between the conflict and this read (rare). Surface as retryable.
      throw new BadRequestException('Payment is being processed, please retry');
    }
    return {
      paymentId: existing.id,
      paymentStatus: existing.status,
      transactionStatus: existing.status === 'SUCCESS' ? 'PAID' : 'PENDING',
      invoiceUrl: existing.checkoutUrl,
      expiredAt: existing.expiredAt,
      amount: existing.amount,
      fee: existing.fee,
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

  async listTransactions(
    memberId: string,
    page = 1,
    perPage = 20,
    filters: {
      status?: CommerceTransactionStatus[];
      search?: string;
      createdFrom?: Date;
      createdTo?: Date;
    } = {},
  ) {
    const where: Prisma.CommerceTransactionWhereInput = { memberId };
    if (filters.status && filters.status.length > 0) {
      where.status = { in: filters.status };
    }
    if (filters.createdFrom || filters.createdTo) {
      where.createdAt = {
        ...(filters.createdFrom ? { gte: filters.createdFrom } : {}),
        ...(filters.createdTo ? { lte: filters.createdTo } : {}),
      };
    }
    const search = filters.search?.trim();
    if (search) {
      where.product = { title: { contains: search, mode: 'insensitive' } };
    }

    const [rows, total] = await Promise.all([
      prisma.commerceTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
        include: { product: { select: { id: true, title: true, thumbnail: true } } },
      }),
      prisma.commerceTransaction.count({ where }),
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
          data: { status: 'CANCELED', activeSlotTxId: null },
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

/**
 * True when an error is a unique-constraint violation on the `active_slot_tx_id` index —
 * i.e. another concurrent checkout already claimed this transaction's active payment slot.
 * On the claim INSERT no other unique column is set, so a bare P2002 is unambiguously ours.
 */
function isActiveSlotConflict(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') return false;
  const target = e.meta?.target;
  if (target == null) return true;
  const s = Array.isArray(target) ? target.join(',') : String(target);
  return s.includes('active_slot_tx_id');
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
