import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { buildApp } from '@/app';
import { prisma } from '@/config/prisma';
import { commerceEvents } from '@/common/events/commerce-events';
import {
  createTestMember,
  createTestProduct,
  createPendingTransaction,
  cleanup,
} from './fixtures';

const CALLBACK_TOKEN = 'test-xendit-token';

function uid(): string {
  return `xnd-${Math.random().toString(36).slice(2, 12)}`;
}

describe('Xendit webhook callbacks', () => {
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
    const r = await request(app).post('/api/webhook/xendit/va').send({ id: 'x' });
    expect(r.status).toBe(401);
  });

  it('rejects wrong token (401)', async () => {
    const r = await request(app)
      .post('/api/webhook/xendit/va')
      .set('x-callback-token', 'wrong-token')
      .send({ id: 'x' });
    expect(r.status).toBe(401);
  });

  it('VA callback flips PENDING → SUCCESS + tx PAID + emits event', async () => {
    const tx = await createPendingTransaction(memberId, productId, 500_000);
    const xenditId = uid();
    const payment = await prisma.commercePayment.create({
      data: {
        transactionId: tx.id,
        memberId,
        paymentType: 'va',
        bank: 'BCA',
        amount: 500_000,
        status: 'PENDING',
        externalId: uid(),
        xenditId,
        xenditVaId: xenditId,
        vaNumber: '8888812345678901',
      },
    });

    const r = await request(app)
      .post('/api/webhook/xendit/va')
      .set('x-callback-token', CALLBACK_TOKEN)
      .send({
        callback_virtual_account_id: xenditId,
        status: 'COMPLETED',
        amount: 500_000,
      });

    expect(r.status).toBe(200);
    expect(r.body.received).toBe(true);
    expect(r.body.noop).toBe(false);

    const after = await prisma.commercePayment.findUnique({ where: { id: payment.id } });
    expect(after?.status).toBe('SUCCESS');
    expect(after?.paidAt).not.toBeNull();

    const txAfter = await prisma.commerceTransaction.findUnique({ where: { id: tx.id } });
    expect(txAfter?.status).toBe('PAID');

    expect(successEvents).toHaveLength(1);
    expect((successEvents[0] as { paymentId: string }).paymentId).toBe(payment.id);
  });

  it('VA callback EXPIRED → tx EXPIRED + emits expired event', async () => {
    const tx = await createPendingTransaction(memberId, productId, 500_000);
    const xenditId = uid();
    const payment = await prisma.commercePayment.create({
      data: {
        transactionId: tx.id,
        memberId,
        paymentType: 'va',
        bank: 'BNI',
        amount: 500_000,
        status: 'PENDING',
        externalId: uid(),
        xenditId,
        xenditVaId: xenditId,
      },
    });

    const r = await request(app)
      .post('/api/webhook/xendit/va')
      .set('x-callback-token', CALLBACK_TOKEN)
      .send({ callback_virtual_account_id: xenditId, status: 'EXPIRED' });

    expect(r.status).toBe(200);
    const after = await prisma.commercePayment.findUnique({ where: { id: payment.id } });
    expect(after?.status).toBe('EXPIRED');
    const txAfter = await prisma.commerceTransaction.findUnique({ where: { id: tx.id } });
    expect(txAfter?.status).toBe('EXPIRED');
    expect(expiredEvents).toHaveLength(1);
  });

  it('eWallet callback SUCCESS', async () => {
    const tx = await createPendingTransaction(memberId, productId, 500_000);
    const xenditId = uid();
    const payment = await prisma.commercePayment.create({
      data: {
        transactionId: tx.id,
        memberId,
        paymentType: 'eWallet',
        ewalletType: 'OVO',
        amount: 500_000,
        status: 'PENDING',
        externalId: uid(),
        xenditId,
      },
    });

    const r = await request(app)
      .post('/api/webhook/xendit/ewallet')
      .set('x-callback-token', CALLBACK_TOKEN)
      .send({ id: xenditId, status: 'SUCCEEDED' });

    expect(r.status).toBe(200);
    const after = await prisma.commercePayment.findUnique({ where: { id: payment.id } });
    expect(after?.status).toBe('SUCCESS');
    expect(successEvents).toHaveLength(1);
  });

  it('CC callback FAILED → emits failed event', async () => {
    const tx = await createPendingTransaction(memberId, productId, 500_000);
    const xenditId = uid();
    const payment = await prisma.commercePayment.create({
      data: {
        transactionId: tx.id,
        memberId,
        paymentType: 'cc',
        amount: 500_000,
        status: 'PENDING',
        externalId: uid(),
        xenditId,
      },
    });

    const r = await request(app)
      .post('/api/webhook/xendit/cc')
      .set('x-callback-token', CALLBACK_TOKEN)
      .send({ id: xenditId, status: 'FAILED', failure_reason: 'CARD_DECLINED' });

    expect(r.status).toBe(200);
    const after = await prisma.commercePayment.findUnique({ where: { id: payment.id } });
    expect(after?.status).toBe('FAILED');
    expect(failedEvents).toHaveLength(1);
    expect((failedEvents[0] as { reason?: string }).reason).toBe('CARD_DECLINED');
  });

  it('idempotency: redelivered webhook on terminal payment is no-op', async () => {
    const tx = await createPendingTransaction(memberId, productId, 500_000);
    const xenditId = uid();
    const payment = await prisma.commercePayment.create({
      data: {
        transactionId: tx.id,
        memberId,
        paymentType: 'va',
        bank: 'MANDIRI',
        amount: 500_000,
        status: 'SUCCESS', // already terminal
        externalId: uid(),
        xenditId,
        xenditVaId: xenditId,
        paidAt: new Date(),
      },
    });

    const r = await request(app)
      .post('/api/webhook/xendit/va')
      .set('x-callback-token', CALLBACK_TOKEN)
      .send({ callback_virtual_account_id: xenditId, status: 'COMPLETED' });

    expect(r.status).toBe(200);
    expect(r.body.noop).toBe(true);
    expect(successEvents).toHaveLength(0);

    const eventsCount = await prisma.commercePaymentEvent.count({
      where: { paymentId: payment.id },
    });
    expect(eventsCount).toBe(0);
  });

  it('unknown xenditId returns 200 noop (no payment row)', async () => {
    const r = await request(app)
      .post('/api/webhook/xendit/va')
      .set('x-callback-token', CALLBACK_TOKEN)
      .send({ callback_virtual_account_id: 'xnd-unknown-xxxx', status: 'COMPLETED' });

    expect(r.status).toBe(200);
    expect(r.body.noop).toBe(true);
  });

  it('writes CommercePaymentEvent audit row', async () => {
    const tx = await createPendingTransaction(memberId, productId, 500_000);
    const xenditId = uid();
    const payment = await prisma.commercePayment.create({
      data: {
        transactionId: tx.id,
        memberId,
        paymentType: 'va',
        bank: 'BRI',
        amount: 500_000,
        status: 'PENDING',
        externalId: uid(),
        xenditId,
        xenditVaId: xenditId,
      },
    });

    await request(app)
      .post('/api/webhook/xendit/va')
      .set('x-callback-token', CALLBACK_TOKEN)
      .send({ callback_virtual_account_id: xenditId, status: 'COMPLETED' });

    const events = await prisma.commercePaymentEvent.findMany({
      where: { paymentId: payment.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe('webhook');
    expect(events[0].fromStatus).toBe('PENDING');
    expect(events[0].toStatus).toBe('SUCCESS');
  });
});
