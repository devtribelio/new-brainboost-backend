import { prisma } from '@/config/prisma';
import { logger } from '@/config/logger';
import { commerceEvents } from '@/common/events/commerce-events';
import type { CommercePaymentStatus } from '@prisma/client';

export type XenditChannel = 'va' | 'ewallet' | 'cc';

export class XenditWebhookHandler {
  async handle(channel: XenditChannel, payload: Record<string, unknown>): Promise<{ noop: boolean }> {
    const xenditId = this.extractXenditId(channel, payload);
    if (!xenditId) {
      logger.warn({ channel, payload }, '[webhook] missing xenditId in payload');
      return { noop: true };
    }

    const payment = await prisma.commercePayment.findFirst({
      where: this.lookupClause(channel, xenditId),
    });
    if (!payment) {
      logger.warn({ channel, xenditId }, '[webhook] no matching CommercePayment');
      return { noop: true };
    }

    if (this.isTerminal(payment.status)) {
      logger.info({ paymentId: payment.id, status: payment.status }, '[webhook] noop (terminal)');
      return { noop: true };
    }

    const nextStatus = this.mapStatus(channel, payload);
    const now = new Date();

    await prisma.$transaction(async (txdb) => {
      await txdb.commercePayment.update({
        where: { id: payment.id },
        data: {
          status: nextStatus,
          vendorStatus: (payload['status'] as string) ?? null,
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
        reason: (payload['failure_reason'] as string) ?? undefined,
      });
    }

    return { noop: false };
  }

  private isTerminal(s: CommercePaymentStatus): boolean {
    return s === 'SUCCESS' || s === 'EXPIRED' || s === 'FAILED' || s === 'CANCELED';
  }

  private extractXenditId(channel: XenditChannel, payload: Record<string, unknown>): string | null {
    if (channel === 'va') {
      return (
        (payload['callback_virtual_account_id'] as string) ??
        (payload['id'] as string) ??
        null
      );
    }
    return (payload['id'] as string) ?? null;
  }

  private lookupClause(channel: XenditChannel, xenditId: string) {
    if (channel === 'va') {
      return { OR: [{ xenditVaId: xenditId }, { xenditId }] };
    }
    return { xenditId };
  }

  private mapStatus(
    channel: XenditChannel,
    payload: Record<string, unknown>,
  ): CommercePaymentStatus {
    const raw = String(payload['status'] ?? '').toUpperCase();
    if (raw === 'COMPLETED' || raw === 'PAID' || raw === 'SUCCEEDED' || raw === 'SUCCESS') {
      return 'SUCCESS';
    }
    if (raw === 'EXPIRED') return 'EXPIRED';
    if (raw === 'FAILED') return 'FAILED';
    if (channel === 'va' && raw === 'ACTIVE') return 'PENDING';
    return 'PENDING';
  }
}
