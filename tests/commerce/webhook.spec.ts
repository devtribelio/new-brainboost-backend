import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { buildApp } from '@/app';
import { prisma } from '@bb/db';
import { commerceEvents } from '@/common/events/commerce-events';
import {
  createTestMember,
  createTestProduct,
  createPendingTransaction,
  cleanup,
} from './fixtures';

const CALLBACK_TOKEN = 'test-xendit-token';
const ROUTE = '/api/webhook/xendit/invoice';

function uid(): string {
  return `xnd-${Math.random().toString(36).slice(2, 12)}`;
}

function invoiceCallback(opts: {
  invoiceId: string;
  status: string;
  paymentChannel?: string;
  paymentDestination?: string;
  paidAmount?: number;
  amount?: number;
  currency?: string;
}): Record<string, unknown> {
  return {
    id: opts.invoiceId,
    external_id: `commerce-${uid()}`,
    status: opts.status,
    amount: opts.amount ?? 500_000,
    paid_amount: opts.paidAmount ?? 500_000,
    currency: opts.currency ?? 'IDR',
    payment_method: 'BANK_TRANSFER',
    payment_channel: opts.paymentChannel ?? 'BCA',
    payment_destination: opts.paymentDestination ?? '8888812345678901',
    paid_at: new Date().toISOString(),
  };
}

describe('Xendit Invoice webhook', () => {
  const app = buildApp();
  let memberId = '';
  let productId = '';
  const successEvents: unknown[] = [];
  const expiredEvents: unknown[] = [];
  const failedEvents: unknown[] = [];

  beforeAll(async () => {
    const m = await createTestMember('wh');
    memberId = m.id;
    const p = await createTestProduct('Webhook Test', 500_000);
    productId = p.id;
    commerceEvents.on('commerce.payment.success', (e) => successEvents.push(e));
    commerceEvents.on('commerce.payment.expired', (e) => expiredEvents.push(e));
    commerceEvents.on('commerce.payment.failed', (e) => failedEvents.push(e));
  });

  beforeEach(() => {
    successEvents.length = 0;
    expiredEvents.length = 0;
    failedEvents.length = 0;
  });

  afterAll(async () => {
    await cleanup(memberId, productId);
    await prisma.$disconnect();
  });

  it('rejects missing token (401)', async () => {
    const r = await request(app)
      .post(ROUTE)
      .send(invoiceCallback({ invoiceId: 'x', status: 'PAID' }));
    expect(r.status).toBe(401);
  });

  it('rejects wrong token (401)', async () => {
    const r = await request(app)
      .post(ROUTE)
      .set('x-callback-token', 'wrong-token')
      .send(invoiceCallback({ invoiceId: 'x', status: 'PAID' }));
    expect(r.status).toBe(401);
  });

  it('PAID → SUCCESS + tx PAID + emits event', async () => {
    const tx = await createPendingTransaction(memberId, productId, 500_000);
    const invoiceId = `inv-${uid()}`;
    const payment = await prisma.commercePayment.create({
      data: {
        transactionId: tx.id,
        memberId,
        paymentType: 'invoice',
        amount: 500_000,
        status: 'PENDING',
        externalId: uid(),
        xenditId: invoiceId,
      },
    });

    const r = await request(app)
      .post(ROUTE)
      .set('x-callback-token', CALLBACK_TOKEN)
      .send(invoiceCallback({ invoiceId, status: 'PAID' }));

    expect(r.status).toBe(200);
    expect(r.body.noop).toBe(false);

    const after = await prisma.commercePayment.findUnique({ where: { id: payment.id } });
    expect(after?.status).toBe('SUCCESS');
    expect(after?.paidAt).not.toBeNull();
    expect(after?.bank).toBe('BCA');
    expect(after?.vaNumber).toBe('8888812345678901');

    const txAfter = await prisma.commerceTransaction.findUnique({ where: { id: tx.id } });
    expect(txAfter?.status).toBe('PAID');

    expect(successEvents).toHaveLength(1);
    expect((successEvents[0] as { paymentId: string }).paymentId).toBe(payment.id);
  });

  it('EXPIRED → tx EXPIRED + emits expired event', async () => {
    const tx = await createPendingTransaction(memberId, productId, 500_000);
    const invoiceId = `inv-${uid()}`;
    const payment = await prisma.commercePayment.create({
      data: {
        transactionId: tx.id,
        memberId,
        paymentType: 'invoice',
        amount: 500_000,
        status: 'PENDING',
        externalId: uid(),
        xenditId: invoiceId,
      },
    });

    const r = await request(app)
      .post(ROUTE)
      .set('x-callback-token', CALLBACK_TOKEN)
      .send(invoiceCallback({ invoiceId, status: 'EXPIRED' }));

    expect(r.status).toBe(200);
    const after = await prisma.commercePayment.findUnique({ where: { id: payment.id } });
    expect(after?.status).toBe('EXPIRED');
    const txAfter = await prisma.commerceTransaction.findUnique({ where: { id: tx.id } });
    expect(txAfter?.status).toBe('EXPIRED');
    expect(expiredEvents).toHaveLength(1);
  });

  it('idempotency: redelivered webhook on terminal payment is no-op', async () => {
    const tx = await createPendingTransaction(memberId, productId, 500_000);
    const invoiceId = `inv-${uid()}`;
    const payment = await prisma.commercePayment.create({
      data: {
        transactionId: tx.id,
        memberId,
        paymentType: 'invoice',
        amount: 500_000,
        status: 'SUCCESS',
        externalId: uid(),
        xenditId: invoiceId,
        paidAt: new Date(),
      },
    });

    const r = await request(app)
      .post(ROUTE)
      .set('x-callback-token', CALLBACK_TOKEN)
      .send(invoiceCallback({ invoiceId, status: 'PAID' }));

    expect(r.status).toBe(200);
    expect(r.body.noop).toBe(true);
    expect(successEvents).toHaveLength(0);

    const eventsCount = await prisma.commercePaymentEvent.count({
      where: { paymentId: payment.id },
    });
    expect(eventsCount).toBe(0);
  });

  it('unknown invoice id returns 200 noop (no payment row)', async () => {
    const r = await request(app)
      .post(ROUTE)
      .set('x-callback-token', CALLBACK_TOKEN)
      .send(invoiceCallback({ invoiceId: `inv-unknown-${uid()}`, status: 'PAID' }));

    expect(r.status).toBe(200);
    expect(r.body.noop).toBe(true);
  });

  it('writes CommercePaymentEvent audit row', async () => {
    const tx = await createPendingTransaction(memberId, productId, 500_000);
    const invoiceId = `inv-${uid()}`;
    const payment = await prisma.commercePayment.create({
      data: {
        transactionId: tx.id,
        memberId,
        paymentType: 'invoice',
        amount: 500_000,
        status: 'PENDING',
        externalId: uid(),
        xenditId: invoiceId,
      },
    });

    await request(app)
      .post(ROUTE)
      .set('x-callback-token', CALLBACK_TOKEN)
      .send(invoiceCallback({ invoiceId, status: 'PAID' }));

    const events = await prisma.commercePaymentEvent.findMany({
      where: { paymentId: payment.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe('webhook');
    expect(events[0].fromStatus).toBe('PENDING');
    expect(events[0].toStatus).toBe('SUCCESS');
  });

  it('refuses SUCCESS when paid_amount does not match the payment amount', async () => {
    const tx = await createPendingTransaction(memberId, productId, 500_000);
    const invoiceId = `inv-${uid()}`;
    const payment = await prisma.commercePayment.create({
      data: {
        transactionId: tx.id,
        memberId,
        paymentType: 'invoice',
        amount: 500_000,
        status: 'PENDING',
        externalId: uid(),
        xenditId: invoiceId,
      },
    });

    const r = await request(app)
      .post(ROUTE)
      .set('x-callback-token', CALLBACK_TOKEN)
      .send(invoiceCallback({ invoiceId, status: 'PAID', paidAmount: 1 }));

    expect(r.status).toBe(200);
    expect(r.body.noop).toBe(true);
    expect(r.body.reason).toBe('amount_mismatch');

    const after = await prisma.commercePayment.findUnique({ where: { id: payment.id } });
    expect(after?.status).toBe('PENDING');

    const txAfter = await prisma.commerceTransaction.findUnique({ where: { id: tx.id } });
    expect(txAfter?.status).toBe('PENDING');

    expect(successEvents).toHaveLength(0);

    // rejected callback is still recorded for audit, with no state transition
    const events = await prisma.commercePaymentEvent.findMany({
      where: { paymentId: payment.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0].fromStatus).toBe('PENDING');
    expect(events[0].toStatus).toBe('PENDING');
  });

  it('refuses SUCCESS when the callback currency is not IDR', async () => {
    const tx = await createPendingTransaction(memberId, productId, 500_000);
    const invoiceId = `inv-${uid()}`;
    const payment = await prisma.commercePayment.create({
      data: {
        transactionId: tx.id,
        memberId,
        paymentType: 'invoice',
        amount: 500_000,
        status: 'PENDING',
        externalId: uid(),
        xenditId: invoiceId,
      },
    });

    const r = await request(app)
      .post(ROUTE)
      .set('x-callback-token', CALLBACK_TOKEN)
      .send(invoiceCallback({ invoiceId, status: 'PAID', currency: 'USD' }));

    expect(r.status).toBe(200);
    expect(r.body.noop).toBe(true);
    expect(r.body.reason).toBe('currency_mismatch');

    const after = await prisma.commercePayment.findUnique({ where: { id: payment.id } });
    expect(after?.status).toBe('PENDING');
    expect(successEvents).toHaveLength(0);
  });

  it('rejects a malformed callback body (missing status) with 400', async () => {
    const r = await request(app)
      .post(ROUTE)
      .set('x-callback-token', CALLBACK_TOKEN)
      .send({ id: `inv-${uid()}` });

    expect(r.status).toBe(400);
  });
});
