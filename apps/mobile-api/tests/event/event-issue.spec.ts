import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { prisma } from '@bb/db';
import { commerceEvents } from '@bb/common/events/commerce-events';
import type { CommercePaymentSuccessEvent } from '@bb/common/events/commerce-events';
import { registerEventTicketListeners } from '@bb/domain/event/listeners/ticket-issue.listener';
import { registerCommsEmailListeners } from '@bb/domain/comms/listeners/commerce-email.listener';
import { registerCommerceNotificationListener } from '@bb/domain/notification/listeners/commerce.listener';

const HOUR = 3600 * 1000;
const created = { events: [] as string[], products: [] as string[], members: [] as string[] };

beforeAll(() => {
  registerEventTicketListeners();
  registerCommsEmailListeners();
  registerCommerceNotificationListener();
});

async function seedPaidOrder(opts: { tickets?: number; productType?: string } = {}) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const event = await prisma.event.create({
    data: {
      slug: `issue-event-${suffix}`,
      title: `Issue Event ${suffix}`,
      startsAt: new Date(Date.now() + 48 * HOUR),
      status: 'ON_SALE',
    },
  });
  created.events.push(event.id);

  const product = await prisma.product.create({
    data: {
      type: opts.productType ?? 'event_ticket',
      title: `Ticket ${suffix}`,
      price: 100000,
      isActive: true,
    },
  });
  created.products.push(product.id);

  const type = await prisma.eventTicketType.create({
    data: { eventId: event.id, productId: product.id, name: 'Online', kind: 'ONLINE', quota: 10 },
  });

  const member = await prisma.member.create({
    data: { email: `issue-${suffix}@test.local`, passwordHash: 'x', fullName: 'Buyer' },
  });
  created.members.push(member.id);

  const tx = await prisma.commerceTransaction.create({
    data: {
      code: `TEST-ISS-${suffix}`,
      memberId: member.id,
      productId: product.id,
      qty: opts.tickets ?? 2,
      itemTotal: 200000,
      amount: 200000,
      status: 'PAID',
      paidAt: new Date(),
    },
  });

  for (let i = 0; i < (opts.tickets ?? 2); i++) {
    await prisma.eventTicket.create({
      data: {
        code: `BBT-${suffix.slice(-4)}${i}${Math.floor(Math.random() * 90 + 10)}`,
        ticketTypeId: type.id,
        transactionId: tx.id,
        buyerMemberId: member.id,
        attendeeName: `Peserta ${i}`,
        attendeeEmail: `peserta${i}-${suffix}@test.local`,
        status: 'RESERVED',
      },
    });
  }

  return { tx, member, product };
}

function paymentSuccess(tx: { id: string; memberId: string; productId: string }): CommercePaymentSuccessEvent {
  return {
    paymentId: `01a08400-0000-7000-8000-${Math.floor(Math.random() * 1e12).toString().padStart(12, '0')}`,
    transactionId: tx.id,
    memberId: tx.memberId,
    productId: tx.productId,
    amount: 200000,
    voucherAmount: 0,
    voucherId: null,
    channel: 'xendit',
  };
}

/** The listeners are async and fire-and-forget — give the bus a tick to drain. */
async function settle() {
  await new Promise((r) => setTimeout(r, 250));
}

afterEach(async () => {
  await prisma.notificationOutbox.deleteMany({
    where: { type: { in: ['EventTicketIssued', 'EventOrderSummary', 'CoursePaymentSuccess', 'SaleAlert'] } },
  });
  await prisma.notification.deleteMany({ where: { memberId: { in: created.members } } });
  await prisma.eventTicket.deleteMany({ where: { buyerMemberId: { in: created.members } } });
  await prisma.commerceTransaction.deleteMany({ where: { memberId: { in: created.members } } });
  await prisma.eventTicketType.deleteMany({ where: { eventId: { in: created.events } } });
  await prisma.event.deleteMany({ where: { id: { in: created.events } } });
  await prisma.product.deleteMany({ where: { id: { in: created.products } } });
  await prisma.member.deleteMany({ where: { id: { in: created.members } } });
  created.events = [];
  created.products = [];
  created.members = [];
});

describe('event ticket issue listener', () => {
  it('flips every RESERVED ticket to ISSUED and queues one email each plus a summary', async () => {
    const { tx } = await seedPaidOrder({ tickets: 3 });

    commerceEvents.emit('commerce.payment.success', paymentSuccess(tx));
    await settle();

    const tickets = await prisma.eventTicket.findMany({ where: { transactionId: tx.id } });
    expect(tickets).toHaveLength(3);
    expect(tickets.every((t) => t.status === 'ISSUED')).toBe(true);
    expect(tickets.every((t) => t.issuedAt !== null)).toBe(true);
    expect(tickets.every((t) => t.emailSentAt !== null)).toBe(true);

    const perTicket = await prisma.notificationOutbox.findMany({
      where: { type: 'EventTicketIssued', refId: { in: tickets.map((t) => t.id) } },
    });
    expect(perTicket).toHaveLength(3);

    const summary = await prisma.notificationOutbox.findMany({
      where: { type: 'EventOrderSummary', refId: tx.id },
    });
    expect(summary).toHaveLength(1);
  });

  it('does not duplicate emails when the webhook is redelivered', async () => {
    const { tx } = await seedPaidOrder({ tickets: 2 });

    commerceEvents.emit('commerce.payment.success', paymentSuccess(tx));
    await settle();
    commerceEvents.emit('commerce.payment.success', paymentSuccess(tx));
    await settle();

    const tickets = await prisma.eventTicket.findMany({ where: { transactionId: tx.id } });
    const perTicket = await prisma.notificationOutbox.count({
      where: { type: 'EventTicketIssued', refId: { in: tickets.map((t) => t.id) } },
    });
    const summary = await prisma.notificationOutbox.count({
      where: { type: 'EventOrderSummary', refId: tx.id },
    });

    expect(perTicket).toBe(2);
    expect(summary).toBe(1);
  });

  it('does not send the course receipt or the sale alert for a ticket order', async () => {
    const { tx } = await seedPaidOrder({ tickets: 1 });

    commerceEvents.emit('commerce.payment.success', paymentSuccess(tx));
    await settle();

    expect(
      await prisma.notificationOutbox.count({
        where: { type: 'CoursePaymentSuccess', refId: tx.id },
      }),
    ).toBe(0);
    expect(
      await prisma.notificationOutbox.count({ where: { type: 'SaleAlert', refId: tx.id } }),
    ).toBe(0);
  });

  it('still sends the course receipt for a normal course order', async () => {
    const { tx } = await seedPaidOrder({ tickets: 0, productType: 'course' });

    commerceEvents.emit('commerce.payment.success', paymentSuccess(tx));
    await settle();

    expect(
      await prisma.notificationOutbox.count({
        where: { type: 'CoursePaymentSuccess', refId: tx.id },
      }),
    ).toBe(1);
  });

  it('writes no in-app notification for a ticket order — the buyer may be a guest', async () => {
    const { tx, member } = await seedPaidOrder({ tickets: 1 });

    commerceEvents.emit('commerce.payment.success', paymentSuccess(tx));
    await settle();

    expect(await prisma.notification.count({ where: { memberId: member.id } })).toBe(0);
  });

  it('still writes the in-app notification for a course order', async () => {
    const { tx, member } = await seedPaidOrder({ tickets: 0, productType: 'course' });

    commerceEvents.emit('commerce.payment.success', paymentSuccess(tx));
    await settle();

    expect(await prisma.notification.count({ where: { memberId: member.id } })).toBe(1);
  });

  it('ignores an order that has no tickets at all', async () => {
    const { tx } = await seedPaidOrder({ tickets: 0, productType: 'course' });

    commerceEvents.emit('commerce.payment.success', paymentSuccess(tx));
    await settle();

    expect(
      await prisma.notificationOutbox.count({ where: { type: 'EventOrderSummary', refId: tx.id } }),
    ).toBe(0);
  });
});
