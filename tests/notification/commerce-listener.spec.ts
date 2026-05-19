import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { prisma } from '@/config/prisma';
import { commerceEvents } from '@/common/events/commerce-events';
import { registerCommerceNotificationListener } from '@/modules/notification/listeners/commerce.listener';

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('commerce.payment.success → notification listener', () => {
  let memberId = '';
  let productId = '';

  beforeAll(async () => {
    registerCommerceNotificationListener();

    const m = await prisma.member.create({
      data: { email: `notif-buyer-${uid()}@test.local`, passwordHash: await bcrypt.hash('s', 4) },
    });
    memberId = m.id;

    const product = await prisma.product.create({
      data: { type: 'course', title: 'Notif Test Course', price: 200_000 },
    });
    productId = product.id;
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { memberId } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.member.delete({ where: { id: memberId } });
    await prisma.$disconnect();
  });

  it('creates a paymentSuccess notification for the buyer', async () => {
    const paymentId = randomUUID();
    commerceEvents.emit('commerce.payment.success', {
      paymentId,
      transactionId: randomUUID(),
      memberId,
      productId,
      amount: 200_000,
      voucherAmount: 0,
      voucherId: null,
      affiliatorId: null,
      programId: null,
    });
    await wait(150);

    const rows = await prisma.notification.findMany({
      where: { memberId, type: 'paymentSuccess' },
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const match = rows.find((r) => r.dedupeKey === `paymentSuccess:${paymentId}:${memberId}`);
    expect(match).toBeDefined();
    expect(match?.title).toBe('Payment successful');
  });

  it('dedupes on re-emit of same paymentId', async () => {
    const paymentId = randomUUID();
    const payload = {
      paymentId,
      transactionId: randomUUID(),
      memberId,
      productId,
      amount: 200_000,
      voucherAmount: 0,
      voucherId: null,
      affiliatorId: null,
      programId: null,
    };

    commerceEvents.emit('commerce.payment.success', payload);
    await wait(150);
    commerceEvents.emit('commerce.payment.success', payload);
    await wait(150);

    const rows = await prisma.notification.findMany({
      where: { dedupeKey: `paymentSuccess:${paymentId}:${memberId}` },
    });
    expect(rows).toHaveLength(1);
  });
});
