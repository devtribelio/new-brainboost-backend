import { describe, it, expect, afterEach } from 'vitest';
import { prisma } from '@bb/db';
import { expireEventTicketOrders } from '@bb/domain/jobs/expire-event-ticket-orders';

const HOUR = 3600 * 1000;
const created = { events: [] as string[], products: [] as string[], members: [] as string[] };

async function seed(opts: {
  txStatus: string;
  expiredAt?: Date | null;
  ticketStatus?: string;
  quota?: number;
}) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const event = await prisma.event.create({
    data: {
      slug: `expire-event-${suffix}`,
      title: `Expire Event ${suffix}`,
      startsAt: new Date(Date.now() + 48 * HOUR),
      status: 'ON_SALE',
    },
  });
  created.events.push(event.id);

  const product = await prisma.product.create({
    data: { type: 'event_ticket', title: `Ticket ${suffix}`, price: 100000, isActive: true },
  });
  created.products.push(product.id);

  const type = await prisma.eventTicketType.create({
    data: {
      eventId: event.id,
      productId: product.id,
      name: 'Online',
      kind: 'ONLINE',
      quota: opts.quota ?? 5,
    },
  });

  const member = await prisma.member.create({
    data: { email: `expire-${suffix}@test.local`, passwordHash: 'x', fullName: 'Buyer' },
  });
  created.members.push(member.id);

  const tx = await prisma.commerceTransaction.create({
    data: {
      code: `TEST-EXP-${suffix}`,
      memberId: member.id,
      productId: product.id,
      qty: 1,
      itemTotal: 100000,
      amount: 100000,
      status: opts.txStatus as 'PENDING',
      expiredAt: opts.expiredAt === undefined ? new Date(Date.now() - HOUR) : opts.expiredAt,
    },
  });

  const ticket = await prisma.eventTicket.create({
    data: {
      code: `BBT-${suffix.slice(-4)}${Math.floor(Math.random() * 90 + 10)}`,
      ticketTypeId: type.id,
      transactionId: tx.id,
      buyerMemberId: member.id,
      attendeeName: 'Peserta',
      attendeeEmail: `peserta-${suffix}@test.local`,
      status: opts.ticketStatus ?? 'RESERVED',
    },
  });

  return { tx, ticket, type };
}

afterEach(async () => {
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

describe('expireEventTicketOrders', () => {
  it('expires an overdue PENDING order and releases its seat', async () => {
    const { tx, ticket } = await seed({ txStatus: 'PENDING' });

    await expireEventTicketOrders();

    expect((await prisma.commerceTransaction.findUnique({ where: { id: tx.id } }))!.status).toBe(
      'EXPIRED',
    );
    expect((await prisma.eventTicket.findUnique({ where: { id: ticket.id } }))!.status).toBe(
      'EXPIRED',
    );
  });

  it('releases seats of a CANCELED order — the cancel path emits no event', async () => {
    const { ticket } = await seed({ txStatus: 'CANCELED', expiredAt: null });

    await expireEventTicketOrders();

    expect((await prisma.eventTicket.findUnique({ where: { id: ticket.id } }))!.status).toBe(
      'EXPIRED',
    );
  });

  it('leaves a PENDING order that has not expired yet alone', async () => {
    const { tx, ticket } = await seed({
      txStatus: 'PENDING',
      expiredAt: new Date(Date.now() + HOUR),
    });

    await expireEventTicketOrders();

    expect((await prisma.commerceTransaction.findUnique({ where: { id: tx.id } }))!.status).toBe(
      'PENDING',
    );
    expect((await prisma.eventTicket.findUnique({ where: { id: ticket.id } }))!.status).toBe(
      'RESERVED',
    );
  });

  it('never touches a paid order', async () => {
    const { tx, ticket } = await seed({ txStatus: 'PAID' });

    await expireEventTicketOrders();

    expect((await prisma.commerceTransaction.findUnique({ where: { id: tx.id } }))!.status).toBe(
      'PAID',
    );
    expect((await prisma.eventTicket.findUnique({ where: { id: ticket.id } }))!.status).toBe(
      'RESERVED',
    );
  });

  it('never touches an ISSUED ticket', async () => {
    const { ticket } = await seed({ txStatus: 'CANCELED', ticketStatus: 'ISSUED' });

    await expireEventTicketOrders();

    expect((await prisma.eventTicket.findUnique({ where: { id: ticket.id } }))!.status).toBe(
      'ISSUED',
    );
  });

  it('is idempotent — a second sweep changes nothing and reports nothing', async () => {
    await seed({ txStatus: 'PENDING' });

    const first = await expireEventTicketOrders();
    const second = await expireEventTicketOrders();

    expect(first.ticketsReleased).toBe(1);
    expect(second.ticketsReleased).toBe(0);
    expect(second.ordersExpired).toBe(0);
  });

  it('returns the released seat to the quota', async () => {
    const { type } = await seed({ txStatus: 'PENDING', quota: 1 });

    const before = await prisma.eventTicket.count({
      where: { ticketTypeId: type.id, status: { in: ['RESERVED', 'ISSUED'] } },
    });
    await expireEventTicketOrders();
    const after = await prisma.eventTicket.count({
      where: { ticketTypeId: type.id, status: { in: ['RESERVED', 'ISSUED'] } },
    });

    expect(before).toBe(1);
    expect(after).toBe(0);
  });
});
