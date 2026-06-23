import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PaymentService } from '@bb/domain/commerce/payment.service';
import { expirePendingPayments } from '@bb/domain/jobs/expire-pending-payments';
import { prisma } from '@bb/db';
import type { XenditGateway } from '@bb/common/services/xendit-gateway';
import type { CreateInvoiceRequest, Invoice } from 'xendit-node/invoice/models';
import { createTestMember, createTestProduct, createPendingTransaction, cleanup } from './fixtures';

/** Counting mock: tracks how many times Xendit createInvoice was actually hit. */
function makeCountingGateway(counter: { calls: number }): XenditGateway {
  return {
    createInvoice: async (params: CreateInvoiceRequest): Promise<Invoice> => {
      counter.calls += 1;
      return {
        id: `inv-${params.externalId}`,
        externalId: params.externalId,
        status: 'PENDING',
        amount: params.amount,
        currency: 'IDR',
        invoiceUrl: `https://checkout.example/${params.externalId}`,
      } as unknown as Invoice;
    },
    expireInvoice: async () => ({}) as Invoice,
  };
}

describe('PaymentService — concurrency / race safety', () => {
  let memberId = '';
  let productId = '';

  beforeAll(async () => {
    const m = await createTestMember('pay-race');
    memberId = m.id;
    const p = await createTestProduct('Race Test', 300_000);
    productId = p.id;
  });

  afterAll(async () => {
    await cleanup(memberId, productId);
    await prisma.$disconnect();
  });

  it('concurrent invoice creates → one Xendit call, exactly one active payment', async () => {
    const tx = await createPendingTransaction(memberId, productId, 300_000);
    const counter = { calls: 0 };
    const svc = new PaymentService(makeCountingGateway(counter));

    const [a, b] = await Promise.all([
      svc.create(memberId, { transactionId: tx.id }),
      svc.create(memberId, { transactionId: tx.id }),
    ]);

    // Only the slot winner may call Xendit; the loser returns the existing payment.
    expect(counter.calls).toBe(1);
    expect(a.paymentId).toBe(b.paymentId);

    const payments = await prisma.commercePayment.findMany({
      where: { transactionId: tx.id },
    });
    expect(payments).toHaveLength(1);
    expect(payments[0]!.status).toBe('PENDING');
    expect(payments[0]!.activeSlotTxId).toBe(tx.id);
  });

  it('concurrent voucher bypass → exactly one SUCCESS payment, tx PAID once', async () => {
    const tx = await createPendingTransaction(memberId, productId, 0);
    const svc = new PaymentService(makeCountingGateway({ calls: 0 }));

    const results = await Promise.all([
      svc.create(memberId, { transactionId: tx.id }),
      svc.create(memberId, { transactionId: tx.id }),
    ]);

    expect(results[0]!.paymentId).toBe(results[1]!.paymentId);

    const payments = await prisma.commercePayment.findMany({ where: { transactionId: tx.id } });
    expect(payments).toHaveLength(1);
    expect(payments[0]!.status).toBe('SUCCESS');

    const settled = await prisma.commerceTransaction.findUnique({ where: { id: tx.id } });
    expect(settled!.status).toBe('PAID');
  });

  it('retry after EXPIRED is allowed — freed slot can be reclaimed', async () => {
    const tx = await createPendingTransaction(memberId, productId, 300_000);
    const counter = { calls: 0 };
    const svc = new PaymentService(makeCountingGateway(counter));

    const first = await svc.create(memberId, { transactionId: tx.id });

    // Force the payment past expiry, then run the sweep → EXPIRED + slot released.
    await prisma.commercePayment.update({
      where: { id: first.paymentId },
      data: { expiredAt: new Date(Date.now() - 1000) },
    });
    // tx flips to EXPIRED in the sweep; reopen it so a retry checkout is permitted.
    await expirePendingPayments(new Date());
    await prisma.commerceTransaction.update({ where: { id: tx.id }, data: { status: 'PENDING' } });

    const freed = await prisma.commercePayment.findUnique({ where: { id: first.paymentId } });
    expect(freed!.status).toBe('EXPIRED');
    expect(freed!.activeSlotTxId).toBeNull();

    // Retry now succeeds with a brand-new payment row claiming the freed slot.
    const second = await svc.create(memberId, { transactionId: tx.id });
    expect(second.paymentId).not.toBe(first.paymentId);
    expect(counter.calls).toBe(2);

    const active = await prisma.commercePayment.findMany({
      where: { transactionId: tx.id, activeSlotTxId: tx.id },
    });
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(second.paymentId);
  });
});
