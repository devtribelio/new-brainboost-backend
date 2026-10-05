/**
 * PRD D1 (Celah B): an affiliator click that lands AFTER the order is created but
 * BEFORE it is paid still attributes the order — when, and only when, checkout
 * attributed nobody. The resolver runs again at Xendit settle, bounded by the
 * moment of payment; an attribution frozen at checkout is never moved.
 *
 * Requires a reachable Postgres test DB (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { commerceEvents } from '@bb/common/events/commerce-events';
import { AttributionService } from '@bb/domain/affiliate/attribution.service';
import { XenditWebhookHandler } from '../../src/modules/webhook/xendit.handler';

const TAG = `settle-attr-${Date.now()}`;
const AMOUNT = 298_000;
const handler = new XenditWebhookHandler();

type SuccessEvent = { transactionId: string; attributedAffiliatorMemberId?: string | null };

describe('re-attribution at Xendit settle', () => {
  const memberIds: string[] = [];
  const events: SuccessEvent[] = [];
  let productId = '';

  async function mkMember(): Promise<string> {
    const m = await prisma.member.create({
      data: { email: `${TAG}-${randomUUID()}@t.local`, passwordHash: await bcrypt.hash('x', 4) },
    });
    memberIds.push(m.id);
    return m.id;
  }

  async function click(affiliatorMemberId: string, memberId: string, at: Date) {
    await prisma.affiliateVisit.create({
      data: { affiliatorMemberId, memberId, productId, createdAt: at },
    });
  }

  async function pendingOrder(buyer: string, attributedAffiliatorMemberId: string | null = null) {
    const tx = await prisma.commerceTransaction.create({
      data: {
        code: `${TAG}-${randomUUID().slice(0, 8)}`,
        memberId: buyer,
        productId,
        qty: 1,
        itemTotal: AMOUNT,
        amount: AMOUNT,
        status: 'PENDING',
        expiredAt: new Date(Date.now() + 3600 * 1000),
        attributedAffiliatorMemberId,
      },
    });
    const invoiceId = `inv-${randomUUID()}`;
    await prisma.commercePayment.create({
      data: {
        transactionId: tx.id,
        memberId: buyer,
        paymentType: 'invoice',
        amount: AMOUNT,
        status: 'PENDING',
        externalId: randomUUID(),
        xenditId: invoiceId,
      },
    });
    return { txId: tx.id, invoiceId };
  }

  async function pay(invoiceId: string) {
    return handler.handle({
      id: invoiceId,
      status: 'PAID',
      amount: AMOUNT,
      paid_amount: AMOUNT,
      currency: 'IDR',
    });
  }

  beforeAll(async () => {
    const p = await prisma.product.create({
      data: { type: 'course', title: `${TAG}-product`, price: AMOUNT },
    });
    productId = p.id;
    commerceEvents.on('commerce.payment.success', (e) => events.push(e as SuccessEvent));
  });

  beforeEach(() => {
    events.length = 0;
  });

  afterAll(async () => {
    if (memberIds.length) {
      await prisma.commercePaymentEvent.deleteMany({ where: { payment: { memberId: { in: memberIds } } } });
      await prisma.commercePayment.deleteMany({ where: { memberId: { in: memberIds } } });
      await prisma.commerceTransaction.deleteMany({ where: { memberId: { in: memberIds } } });
      await prisma.affiliateVisit.deleteMany({ where: { memberId: { in: memberIds } } });
      await prisma.member.deleteMany({ where: { id: { in: memberIds } } });
    }
    if (productId) await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.$disconnect();
  });

  it('attributes an unattributed order to a click made between checkout and payment', async () => {
    const buyer = await mkMember();
    const aff = await mkMember();
    const { txId, invoiceId } = await pendingOrder(buyer);
    await click(aff, buyer, new Date(Date.now() - 1000));

    await pay(invoiceId);

    const tx = await prisma.commerceTransaction.findUnique({ where: { id: txId } });
    expect(tx?.attributedAffiliatorMemberId).toBe(aff);
    expect(events.find((e) => e.transactionId === txId)?.attributedAffiliatorMemberId).toBe(aff);
  });

  it('never moves an attribution frozen at checkout', async () => {
    const buyer = await mkMember();
    const affA = await mkMember();
    const affB = await mkMember();
    const { txId, invoiceId } = await pendingOrder(buyer, affA);
    await click(affB, buyer, new Date(Date.now() - 1000));

    await pay(invoiceId);

    const tx = await prisma.commerceTransaction.findUnique({ where: { id: txId } });
    expect(tx?.attributedAffiliatorMemberId).toBe(affA);
    expect(events.find((e) => e.transactionId === txId)?.attributedAffiliatorMemberId).toBe(affA);
  });

  it('leaves the order unattributed when there is no click', async () => {
    const buyer = await mkMember();
    const { txId, invoiceId } = await pendingOrder(buyer);

    await pay(invoiceId);

    const tx = await prisma.commerceTransaction.findUnique({ where: { id: txId } });
    expect(tx?.attributedAffiliatorMemberId).toBeNull();
    expect(events.find((e) => e.transactionId === txId)?.attributedAffiliatorMemberId).toBeNull();
  });
});

describe('AttributionService.resolveOverrideAffiliatorMemberId asOf', () => {
  const svc = new AttributionService();
  const ids: string[] = [];
  let productId = '';

  beforeAll(async () => {
    const p = await prisma.product.create({
      data: { type: 'course', title: `${TAG}-asof`, price: AMOUNT },
    });
    productId = p.id;
  });

  afterAll(async () => {
    await prisma.affiliateVisit.deleteMany({ where: { memberId: { in: ids } } });
    await prisma.member.deleteMany({ where: { id: { in: ids } } });
    await prisma.product.deleteMany({ where: { id: productId } });
  });

  it('ignores a click made after asOf and measures the window back from asOf', async () => {
    const [buyer, before, after, stale] = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const m = await prisma.member.create({
          data: { email: `${TAG}-${randomUUID()}@t.local`, passwordHash: await bcrypt.hash('x', 4) },
        });
        ids.push(m.id);
        return m.id;
      }),
    );
    const day = 24 * 3600 * 1000;
    const asOf = new Date(Date.now() - 10 * day);
    await prisma.affiliateVisit.createMany({
      data: [
        { affiliatorMemberId: stale, memberId: buyer, productId, createdAt: new Date(asOf.getTime() - 40 * day) },
        { affiliatorMemberId: before, memberId: buyer, productId, createdAt: new Date(asOf.getTime() - day) },
        { affiliatorMemberId: after, memberId: buyer, productId, createdAt: new Date(asOf.getTime() + day) },
      ],
    });

    expect(await svc.resolveOverrideAffiliatorMemberId(buyer, null, productId, asOf)).toBe(before);
  });
});
