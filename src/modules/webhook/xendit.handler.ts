import { prisma } from '@/config/prisma';
import { logger } from '@/config/logger';
import { commerceEvents } from '@/common/events/commerce-events';
import { mapInvoiceStatus } from '@/modules/commerce/payment.service';
import type { CommercePaymentStatus } from '@prisma/client';

type RawPayload = Record<string, unknown>;

export interface HandleResult {
  noop: boolean;
  reason?: string;
}

/**
 * Xendit Invoice webhook handler. Flat envelope — fields at root (no `data:` wrapper).
 */
export class XenditWebhookHandler {
  async handle(payload: RawPayload): Promise<HandleResult> {
    const invoiceId = payload['id'] as string | undefined;
    const externalId = payload['external_id'] as string | undefined;

    if (!invoiceId && !externalId) {
      logger.warn({ payload }, '[webhook] missing id/external_id');
      return { noop: true, reason: 'missing_id' };
    }

    const payment = await prisma.commercePayment.findFirst({
      where: invoiceId ? { xenditId: invoiceId } : { externalId },
    });
    if (!payment) {
      logger.warn({ invoiceId, externalId }, '[webhook] no matching CommercePayment');
      return { noop: true, reason: 'unknown_payment' };
    }

    if (isTerminal(payment.status)) {
      logger.info(
        { paymentId: payment.id, status: payment.status },
        '[webhook] noop (terminal)',
      );
      return { noop: true, reason: 'already_terminal' };
    }

    const nextStatus = mapInvoiceStatus(payload['status'] as string | undefined);
    const now = new Date();

    await prisma.$transaction(async (txdb) => {
      await txdb.commercePayment.update({
        where: { id: payment.id },
        data: {
          status: nextStatus,
          vendorStatus: (payload['status'] as string) ?? null,
          bank: (payload['payment_channel'] as string) ?? payment.bank,
          vaNumber: (payload['payment_destination'] as string) ?? payment.vaNumber,
          logResponse: payload as unknown as object,
          paidAt: nextStatus === 'SUCCESS' ? now : payment.paidAt,
          updatedAt: now,
        },
      });
      await txdb.commercePaymentEvent.create({
        data: {
          paymentId: payment.id,
          source: 'webhook',
          fromStatus: payment.status,
          toStatus: nextStatus,
          payload: payload as unknown as object,
        },
      });
      if (nextStatus === 'SUCCESS') {
        await txdb.commerceTransaction.update({
          where: { id: payment.transactionId },
          data: { status: 'PAID', paidAt: now },
        });
      } else if (nextStatus === 'EXPIRED') {
        await txdb.commerceTransaction.update({
          where: { id: payment.transactionId },
          data: { status: 'EXPIRED' },
        });
      }
    });

    if (nextStatus === 'SUCCESS') {
      const tx = await prisma.commerceTransaction.findUnique({
        where: { id: payment.transactionId },
        select: {
          id: true,
          memberId: true,
          productId: true,
          amount: true,
          voucherAmount: true,
          voucherId: true,
          affiliatorId: true,
          programId: true,
        },
      });
      if (tx) {
        commerceEvents.emit('commerce.payment.success', {
          paymentId: payment.id,
          transactionId: tx.id,
          memberId: tx.memberId,
          productId: tx.productId,
          amount: tx.amount,
          voucherAmount: tx.voucherAmount,
          voucherId: tx.voucherId,
          affiliatorId: tx.affiliatorId,
          programId: tx.programId,
        });
      }
    } else if (nextStatus === 'EXPIRED') {
      commerceEvents.emit('commerce.payment.expired', {
        paymentId: payment.id,
        transactionId: payment.transactionId,
      });
    } else if (nextStatus === 'FAILED') {
      commerceEvents.emit('commerce.payment.failed', {
        paymentId: payment.id,
        transactionId: payment.transactionId,
        reason: undefined,
      });
    }

    return { noop: false };
  }
}

function isTerminal(s: CommercePaymentStatus): boolean {
  return s === 'SUCCESS' || s === 'EXPIRED' || s === 'FAILED' || s === 'CANCELED';
}
