import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { prisma } from '@bb/db';
import { commerceEvents } from '@bb/common/events/commerce-events';
import { registerCommerceNotificationListener } from '@bb/domain/notification/listeners/commerce.listener';

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('commerce.payment.success → notification listener', () => {
  let memberId = '';
  let productId = '';
  let trialVoucherId = '';

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

    const voucher = await prisma.voucher.create({
      data: { code: `NOTIF-TRIAL-${uid()}`, type: 'TRIAL', value: 0, trialDays: 7, isActive: true },
    });
    trialVoucherId = voucher.id;
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { memberId } });
    await prisma.voucher.delete({ where: { id: trialVoucherId } });
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
    expect(match?.title).toBe('Pembayaran berhasil');
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

  it('a trial grant gets its own type and leads with the end date, not "Pembayaran berhasil"', async () => {
    const paymentId = randomUUID();
    commerceEvents.emit('commerce.payment.success', {
      paymentId,
      transactionId: randomUUID(),
      memberId,
      productId,
      amount: 0, // 100% off — the member was never charged
      voucherAmount: 200_000,
      voucherId: trialVoucherId,
      affiliatorId: null,
      programId: null,
    });
    await wait(200);

    const row = await prisma.notification.findFirst({
      where: { dedupeKey: `trialStarted:${paymentId}:${memberId}` },
    });
    expect(row).toBeDefined();
    expect(row?.type).toBe('trialStarted');
    expect(row?.title).toBe('Uji coba kamu aktif');
    // The end date is the only new information in this push — it must be in the
    // body, where it is not truncated, and it must actually be a date.
    expect(row?.body).toMatch(/terbuka sampai \d{1,2} \w+ \d{4}\.$/);
    expect(row?.body).not.toContain('dibayar');

    const payload = row?.payload as { trialEndsAt?: string } | null;
    expect(payload?.trialEndsAt).toBeTruthy();

    // ...and no paymentSuccess row was written for the same payment.
    const wrong = await prisma.notification.findFirst({
      where: { dedupeKey: `paymentSuccess:${paymentId}:${memberId}` },
    });
    expect(wrong).toBeNull();
  });
});
