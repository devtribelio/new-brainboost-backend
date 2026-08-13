/**
 * Sale alert email (producer side): every successful sale enqueues one
 * SaleAlert outbox row per address configured in app_settings
 * `sales.alertEmail` (comma-separated, empty = off). Renewals are deferred —
 * no SaleAlert for them (plan-backed skip lands with the subscription
 * branch). Rendering lives in bb-comms (external dependency). Real Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@bb/db';
import { commerceEvents } from '@bb/common/events/commerce-events';
import { SettingsService, settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import { registerCommsEmailListeners } from '@bb/domain/comms/listeners/commerce-email.listener';

const uniq = randomUUID().slice(0, 8);

let retailProductId: string;
let memberId: string;

async function settle(ms = 250) {
  await new Promise((r) => setTimeout(r, ms));
}

async function setAlertEmail(value: string) {
  await settingsService.set(SETTING_KEYS.salesAlertEmail, value);
  SettingsService.clearCache();
}

function successEvent(txId: string, productId: string, extra: Record<string, unknown> = {}) {
  return {
    paymentId: `pay-${txId}`,
    transactionId: txId,
    memberId,
    productId,
    amount: 500_000,
    voucherAmount: 0,
    ...extra,
  };
}

async function saleAlertRows(txId: string) {
  return prisma.notificationOutbox.findMany({
    where: { type: 'SaleAlert', refId: txId },
    orderBy: { recipient: 'asc' },
  });
}

async function cleanup() {
  await prisma.notificationOutbox.deleteMany({ where: { refId: { contains: uniq } } });
  await prisma.product.deleteMany({ where: { code: { contains: uniq } } });
  await prisma.member.deleteMany({ where: { email: { contains: uniq } } });
  await prisma.appSetting.deleteMany({ where: { key: SETTING_KEYS.salesAlertEmail } });
  SettingsService.clearCache();
}

beforeAll(async () => {
  await cleanup();
  registerCommsEmailListeners();

  memberId = (
    await prisma.member.create({
      data: { email: `salert-${uniq}@test.local`, passwordHash: 'x', isActive: true },
    })
  ).id;

  retailProductId = (
    await prisma.product.create({
      data: { type: 'course', code: `TSTSA-RTL-${uniq}`, title: 'SA retail', price: 500_000 },
    })
  ).id;
});

afterAll(async () => {
  await cleanup();
});

describe('SaleAlert email producer', () => {
  it('does not enqueue anything while the setting is empty (feature off)', async () => {
    await setAlertEmail('');
    const txId = `tx-off-${uniq}`;
    commerceEvents.emit('commerce.payment.success', successEvent(txId, retailProductId));
    await settle();
    expect(await saleAlertRows(txId)).toHaveLength(0);
  });

  it('enqueues one SaleAlert per configured address on a retail sale', async () => {
    await setAlertEmail(`owner-${uniq}@biz.local, finance-${uniq}@biz.local`);
    const txId = `tx-on-${uniq}`;
    commerceEvents.emit('commerce.payment.success', successEvent(txId, retailProductId));
    await settle();

    const rows = await saleAlertRows(txId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.recipient)).toEqual([
      `finance-${uniq}@biz.local`,
      `owner-${uniq}@biz.local`,
    ]);
    expect(rows.every((r) => r.channel === 'email')).toBe(true);

    // buyer receipt is untouched by the alert fan-out
    const receipts = await prisma.notificationOutbox.findMany({
      where: { type: 'CoursePaymentSuccess', refId: txId },
    });
    expect(receipts).toHaveLength(1);
  });

  it('ignores garbage entries in the address list', async () => {
    await setAlertEmail(` , not-an-email, owner-${uniq}@biz.local ,`);
    const txId = `tx-junk-${uniq}`;
    commerceEvents.emit('commerce.payment.success', successEvent(txId, retailProductId));
    await settle();

    const rows = await saleAlertRows(txId);
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient).toBe(`owner-${uniq}@biz.local`);
  });

  it('skips renewals — deferred scope', async () => {
    await setAlertEmail(`owner-${uniq}@biz.local`);
    const txId = `tx-renew-${uniq}`;
    commerceEvents.emit(
      'commerce.payment.success',
      successEvent(txId, retailProductId, { isRenewal: true }),
    );
    await settle();
    expect(await saleAlertRows(txId)).toHaveLength(0);
  });
});
