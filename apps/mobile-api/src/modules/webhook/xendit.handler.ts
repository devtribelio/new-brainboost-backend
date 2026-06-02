import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { commerceEvents } from '@bb/common/events/commerce-events';
import { mapInvoiceStatus } from '@bb/domain/commerce/payment.service';
import type { CommercePaymentStatus } from '@prisma/client';

type RawPayload = Record<string, unknown>;

export interface HandleResult {
  noop: boolean;
  reason?: string;
}

const TERMINAL_STATUSES: CommercePaymentStatus[] = [
  'SUCCESS',
  'EXPIRED',
  'FAILED',
  'CANCELED',
];

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

    // Fast-path: payment already finalized. The authoritative idempotency guard
    // is the conditional updateMany below — this only avoids needless work.
    if (isTerminal(payment.status)) {
      logger.info(
        { paymentId: payment.id, status: payment.status },
        '[webhook] noop (terminal)',
      );
      return { noop: true, reason: 'already_terminal' };
    }

    const nextStatus = mapInvoiceStatus(payload['status'] as string | undefined);
    const now = new Date();

    // SECURITY: never grant a SUCCESS transition on an unverified amount.
    // The static callback token is a single, replayable factor; the paid
    // amount is the second factor that defeats a forged "PAID" callback.
    if (nextStatus === 'SUCCESS') {
      const verdict = verifyPaidAmount(payload, payment.amount);
      if (!verdict.ok) {
        logger.error(
          {
            paymentId: payment.id,
            reason: verdict.reason,
            expected: payment.amount,
            got: verdict.got,
          },
          '[webhook] amount verification failed — refusing SUCCESS',
        );
        // Record the rejected callback for audit; do NOT transition state.
        await prisma.commercePaymentEvent.create({
          data: {
            paymentId: payment.id,
            source: 'webhook',
            fromStatus: payment.status,
            toStatus: payment.status,
            payload: payload as unknown as object,
          },
        });
        return { noop: true, reason: verdict.reason };
      }
    }

    let applied = false;
    await prisma.$transaction(async (txdb) => {
      // Conditional update: only one webhook can move a payment out of a
      // non-terminal state. A concurrent / replayed callback updates 0 rows,
      // closing the check-then-act race on the fast-path above.
      const updated = await txdb.commercePayment.updateMany({
        where: { id: payment.id, status: { notIn: TERMINAL_STATUSES } },
        data: {
          status: nextStatus,
          vendorStatus: (payload['status'] as string) ?? null,
          bank: (payload['payment_channel'] as string) ?? payment.bank,
          vaNumber: (payload['payment_destination'] as string) ?? payment.vaNumber,
          logResponse: payload as unknown as object,
          paidAt: nextStatus === 'SUCCESS' ? now : payment.paidAt,
          // Free the transaction's active slot on EXPIRED so a retry can reclaim it.
          // SUCCESS keeps the slot occupied (a paid transaction must never get a new payment).
          activeSlotTxId: nextStatus === 'EXPIRED' ? null : payment.activeSlotTxId,
          updatedAt: now,
        },
      });
      if (updated.count === 0) return; // lost the race — already finalized

      applied = true;
      await txdb.commercePaymentEvent.create({
        data: {
          paymentId: payment.id,
          source: 'webhook',
          fromStatus: payment.status,
          toStatus: nextStatus,
          payload: payload as unknown as object,
        },
      });

      // Only settle/downgrade a transaction that is still PENDING — never
      // clobber a transaction another payment row already settled.
      if (nextStatus === 'SUCCESS') {
        await txdb.commerceTransaction.updateMany({
          where: { id: payment.transactionId, status: 'PENDING' },
          data: { status: 'PAID', paidAt: now },
        });
      } else if (nextStatus === 'EXPIRED') {
        await txdb.commerceTransaction.updateMany({
          where: { id: payment.transactionId, status: 'PENDING' },
          data: { status: 'EXPIRED' },
        });
      }
    });

    if (!applied) {
      logger.info(
        { paymentId: payment.id },
        '[webhook] noop (lost race / already finalized)',
      );
      return { noop: true, reason: 'already_terminal' };
    }

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
          attributedAffiliatorMemberId: true,
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
          attributedAffiliatorMemberId: tx.attributedAffiliatorMemberId,
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
  return TERMINAL_STATUSES.includes(s);
}

type AmountVerdict = { ok: true } | { ok: false; reason: string; got: unknown };

/**
 * Verifies the callback's paid amount matches the amount expected for this
 * payment, and that the currency (when present) is IDR. Fails closed: an
 * absent or non-numeric amount is treated as a mismatch, so a SUCCESS
 * transition is never granted without a positively verified amount.
 */
function verifyPaidAmount(payload: RawPayload, expected: number): AmountVerdict {
  const currency = payload['currency'];
  if (typeof currency === 'string' && currency.toUpperCase() !== 'IDR') {
    return { ok: false, reason: 'currency_mismatch', got: currency };
  }
  const paid = payload['paid_amount'] ?? payload['amount'];
  if (typeof paid !== 'number' || !Number.isFinite(paid)) {
    return { ok: false, reason: 'amount_unverifiable', got: paid };
  }
  if (Math.round(paid) !== expected) {
    return { ok: false, reason: 'amount_mismatch', got: paid };
  }
  return { ok: true };
}
