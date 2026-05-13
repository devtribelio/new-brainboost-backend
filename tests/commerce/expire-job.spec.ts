import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@/config/prisma';
import { expirePendingPayments } from '@/jobs/expire-pending-payments';
import {
  createTestMember,
  createTestProduct,
  createPendingTransaction,
  cleanup,
} from './fixtures';

function uid(): string {
  return `xnd-${Math.random().toString(36).slice(2, 12)}`;
}

describe('expirePendingPayments cron', () => {
  let memberId = '';
  let productId = '';

  beforeAll(async () => {
    const m = await createTestMember('exp');
    memberId = m.id;
    const p = await createTestProduct('Expire Test', 100_000);
    productId = p.id;
  });

  afterAll(async () => {
    await cleanup(memberId, productId);
    await prisma.$disconnect();
  });

  it('flips PENDING + past-expiry payments to EXPIRED', async () => {
    const tx = await createPendingTransaction(memberId, productId, 100_000);
    const pastExp = new Date(Date.now() - 60_000);
    const payment = await prisma.commercePayment.create({
      data: {
        transactionId: tx.id,
        memberId,
        paymentType: 'va',
        bank: 'BCA',
        amount: 100_000,
        status: 'PENDING',
        externalId: uid(),
        xenditId: uid(),
        expiredAt: pastExp,
      },
    });

    const result = await expirePendingPayments();
    expect(result.expired).toBeGreaterThanOrEqual(1);

    const after = await prisma.commercePayment.findUnique({ where: { id: payment.id } });
    expect(after?.status).toBe('EXPIRED');

    const txAfter = await prisma.commerceTransaction.findUnique({ where: { id: tx.id } });
    expect(txAfter?.status).toBe('EXPIRED');

    const events = await prisma.commercePaymentEvent.findMany({
      where: { paymentId: payment.id },
    });
    expect(events.some((e) => e.source === 'poll' && e.toStatus === 'EXPIRED')).toBe(true);
  });

  it('ignores PENDING payments still within expiry window', async () => {
    const tx = await createPendingTransaction(memberId, productId, 100_000);
    const futureExp = new Date(Date.now() + 3600_000);
    const payment = await prisma.commercePayment.create({
      data: {
        transactionId: tx.id,
        memberId,
        paymentType: 'va',
        bank: 'BNI',
        amount: 100_000,
        status: 'PENDING',
        externalId: uid(),
        xenditId: uid(),
        expiredAt: futureExp,
      },
    });

    await expirePendingPayments();

    const after = await prisma.commercePayment.findUnique({ where: { id: payment.id } });
    expect(after?.status).toBe('PENDING');
  });

  it('skips already terminal payments', async () => {
    const tx = await createPendingTransaction(memberId, productId, 100_000);
    const pastExp = new Date(Date.now() - 60_000);
    const payment = await prisma.commercePayment.create({
      data: {
        transactionId: tx.id,
        memberId,
        paymentType: 'va',
        bank: 'MANDIRI',
        amount: 100_000,
        status: 'SUCCESS', // already terminal
        externalId: uid(),
        xenditId: uid(),
        expiredAt: pastExp,
        paidAt: new Date(),
      },
    });

    await expirePendingPayments();

    const after = await prisma.commercePayment.findUnique({ where: { id: payment.id } });
    expect(after?.status).toBe('SUCCESS'); // unchanged
  });
});
