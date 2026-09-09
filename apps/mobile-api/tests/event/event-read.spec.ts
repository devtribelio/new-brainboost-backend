import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { prisma } from '@bb/db';
import { buildApp } from '../../src/app';

const app = buildApp();

const HOUR = 3600 * 1000;
const created = { events: [] as string[], products: [] as string[], members: [] as string[] };

async function createEvent(opts: {
  status?: string;
  startsAt?: Date;
  endsAt?: Date | null;
  location?: string | null;
}) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const event = await prisma.event.create({
    data: {
      slug: `test-event-${suffix}`,
      title: `Test Event ${suffix}`,
      description: '<p>Materi</p>',
      startsAt: opts.startsAt ?? new Date(Date.now() + 48 * HOUR),
      endsAt: opts.endsAt === undefined ? new Date(Date.now() + 50 * HOUR) : opts.endsAt,
      location: opts.location === undefined ? 'Zoom' : opts.location,
      status: opts.status ?? 'ON_SALE',
    },
  });
  created.events.push(event.id);
  return event;
}

async function addTicketType(
  eventId: string,
  opts: {
    name?: string;
    price?: number;
    quota?: number | null;
    isActive?: boolean;
    saleStartsAt?: Date | null;
    saleEndsAt?: Date | null;
    sortOrder?: number;
  } = {},
) {
  const product = await prisma.product.create({
    data: {
      type: 'event_ticket',
      title: `Ticket ${Date.now()}-${Math.floor(Math.random() * 100000)}`,
      price: opts.price ?? 150000,
      isActive: true,
      status: 'active',
    },
  });
  created.products.push(product.id);

  return prisma.eventTicketType.create({
    data: {
      eventId,
      productId: product.id,
      name: opts.name ?? 'Online',
      kind: 'ONLINE',
      quota: opts.quota === undefined ? 10 : opts.quota,
      isActive: opts.isActive ?? true,
      saleStartsAt: opts.saleStartsAt ?? null,
      saleEndsAt: opts.saleEndsAt ?? null,
      sortOrder: opts.sortOrder ?? 0,
    },
  });
}

/** Occupy seats without going through checkout (not built yet). */
async function occupySeats(ticketTypeId: string, count: number, status: string) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const member = await prisma.member.create({
    data: {
      email: `event-buyer-${suffix}@test.local`,
      passwordHash: 'x',
      fullName: 'Event Buyer',
    },
  });
  created.members.push(member.id);
  const product = await prisma.product.create({
    data: { type: 'event_ticket', title: `Order product ${suffix}`, price: 1, isActive: true },
  });
  created.products.push(product.id);
  const tx = await prisma.commerceTransaction.create({
    data: {
      code: `TEST-EV-${suffix}`,
      memberId: member.id,
      productId: product.id,
      qty: count,
      itemTotal: 0,
      amount: 0,
      status: 'PENDING',
    },
  });
  for (let i = 0; i < count; i++) {
    await prisma.eventTicket.create({
      data: {
        code: `BBT-${suffix.slice(-4)}${i}${Math.floor(Math.random() * 90 + 10)}`,
        ticketTypeId,
        transactionId: tx.id,
        buyerMemberId: member.id,
        attendeeName: 'Peserta',
        attendeeEmail: `peserta${i}@test.local`,
        status,
      },
    });
  }
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

describe('GET /api/event/on-sale', () => {
  it('lists an ON_SALE event with a sellable ticket type', async () => {
    const event = await createEvent({});
    await addTicketType(event.id, { price: 150000, quota: 10 });

    const res = await request(app).get('/api/event/on-sale').expect(200);
    const item = res.body.data.items.find((i: { slug: string }) => i.slug === event.slug);

    expect(item).toBeDefined();
    expect(item.lowestPrice).toBe(150000);
    expect(item.remainingQuota).toBe(10);
  });

  it('reports the cheapest sellable price and the aggregate quota', async () => {
    const event = await createEvent({});
    await addTicketType(event.id, { name: 'Offline', price: 250000, quota: 5 });
    await addTicketType(event.id, { name: 'Online', price: 100000, quota: 7 });

    const res = await request(app).get('/api/event/on-sale').expect(200);
    const item = res.body.data.items.find((i: { slug: string }) => i.slug === event.slug);

    expect(item.lowestPrice).toBe(100000);
    expect(item.remainingQuota).toBe(12);
  });

  it('reports unlimited quota as null when any type is unlimited', async () => {
    const event = await createEvent({});
    await addTicketType(event.id, { quota: null });
    await addTicketType(event.id, { quota: 5 });

    const res = await request(app).get('/api/event/on-sale').expect(200);
    const item = res.body.data.items.find((i: { slug: string }) => i.slug === event.slug);

    expect(item.remainingQuota).toBeNull();
  });

  it('counts RESERVED seats as taken, not just ISSUED', async () => {
    const event = await createEvent({});
    const type = await addTicketType(event.id, { quota: 10 });
    await occupySeats(type.id, 3, 'RESERVED');
    await occupySeats(type.id, 2, 'ISSUED');

    const res = await request(app).get('/api/event/on-sale').expect(200);
    const item = res.body.data.items.find((i: { slug: string }) => i.slug === event.slug);

    expect(item.remainingQuota).toBe(5);
  });

  it('ignores EXPIRED and VOID tickets when counting seats', async () => {
    const event = await createEvent({});
    const type = await addTicketType(event.id, { quota: 10 });
    await occupySeats(type.id, 4, 'EXPIRED');
    await occupySeats(type.id, 1, 'VOID');

    const res = await request(app).get('/api/event/on-sale').expect(200);
    const item = res.body.data.items.find((i: { slug: string }) => i.slug === event.slug);

    expect(item.remainingQuota).toBe(10);
  });

  it('omits a DRAFT, CLOSED or CANCELED event', async () => {
    for (const status of ['DRAFT', 'CLOSED', 'CANCELED']) {
      const event = await createEvent({ status });
      await addTicketType(event.id, {});
      const res = await request(app).get('/api/event/on-sale').expect(200);
      expect(res.body.data.items.some((i: { slug: string }) => i.slug === event.slug)).toBe(false);
    }
  });

  it('omits a sold-out event', async () => {
    const event = await createEvent({});
    const type = await addTicketType(event.id, { quota: 2 });
    await occupySeats(type.id, 2, 'ISSUED');

    const res = await request(app).get('/api/event/on-sale').expect(200);
    expect(res.body.data.items.some((i: { slug: string }) => i.slug === event.slug)).toBe(false);
  });

  it('omits an event whose sale window has not opened or has closed', async () => {
    const notYet = await createEvent({});
    await addTicketType(notYet.id, { saleStartsAt: new Date(Date.now() + 24 * HOUR) });
    const over = await createEvent({});
    await addTicketType(over.id, { saleEndsAt: new Date(Date.now() - HOUR) });

    const res = await request(app).get('/api/event/on-sale').expect(200);
    const slugs = res.body.data.items.map((i: { slug: string }) => i.slug);
    expect(slugs).not.toContain(notYet.slug);
    expect(slugs).not.toContain(over.slug);
  });

  it('omits an event that has already finished', async () => {
    const event = await createEvent({
      startsAt: new Date(Date.now() - 5 * HOUR),
      endsAt: new Date(Date.now() - HOUR),
    });
    await addTicketType(event.id, {});

    const res = await request(app).get('/api/event/on-sale').expect(200);
    expect(res.body.data.items.some((i: { slug: string }) => i.slug === event.slug)).toBe(false);
  });

  it('still lists an event that has started but not ended', async () => {
    const event = await createEvent({
      startsAt: new Date(Date.now() - HOUR),
      endsAt: new Date(Date.now() + HOUR),
    });
    await addTicketType(event.id, {});

    const res = await request(app).get('/api/event/on-sale').expect(200);
    expect(res.body.data.items.some((i: { slug: string }) => i.slug === event.slug)).toBe(true);
  });

  it('omits an event whose only ticket type is inactive', async () => {
    const event = await createEvent({});
    await addTicketType(event.id, { isActive: false });

    const res = await request(app).get('/api/event/on-sale').expect(200);
    expect(res.body.data.items.some((i: { slug: string }) => i.slug === event.slug)).toBe(false);
  });
});

describe('GET /api/event/:slug', () => {
  it('returns the event with its ticket types', async () => {
    const event = await createEvent({});
    await addTicketType(event.id, { name: 'Online', price: 150000, quota: 10, sortOrder: 0 });
    await addTicketType(event.id, { name: 'Offline', price: 250000, quota: 4, sortOrder: 1 });

    const res = await request(app).get(`/api/event/${event.slug}`).expect(200);
    const data = res.body.data;

    expect(data.title).toBe(event.title);
    expect(data.canBuy).toBe(true);
    expect(data.ticketTypes).toHaveLength(2);
    expect(data.ticketTypes[0].name).toBe('Online');
    expect(data.ticketTypes[0].price).toBe(150000);
    expect(data.ticketTypes[0].remainingQuota).toBe(10);
    expect(data.ticketTypes[0].isOnSale).toBe(true);
    expect(data.ticketTypes[0].maxPerOrder).toBe(10);
  });

  it('returns the announcement strip text and label, but not its target', async () => {
    const event = await createEvent({});
    await addTicketType(event.id, {});
    await prisma.event.update({
      where: { id: event.id },
      data: {
        noticeText: 'Bisa reservasi tiket dulu!',
        noticeLinkLabel: 'Reservasi di sini',
        noticeLinkUrl: 'https://example.test/reserve',
      },
    });

    const res = await request(app).get(`/api/event/${event.slug}`).expect(200);

    expect(res.body.data.noticeText).toBe('Bisa reservasi tiket dulu!');
    expect(res.body.data.noticeLinkLabel).toBe('Reservasi di sini');
    // The target is not part of the contract yet — an unused field in a public
    // payload is one more thing a client can start depending on too early.
    expect(res.body.data).not.toHaveProperty('noticeLinkUrl');
  });

  it('reports no strip as null rather than omitting the fields', async () => {
    const event = await createEvent({});
    await addTicketType(event.id, {});

    const res = await request(app).get(`/api/event/${event.slug}`).expect(200);

    expect(res.body.data.noticeText).toBeNull();
    expect(res.body.data.noticeLinkLabel).toBeNull();
  });

  it('404s a DRAFT event', async () => {
    const event = await createEvent({ status: 'DRAFT' });
    await addTicketType(event.id, {});

    await request(app).get(`/api/event/${event.slug}`).expect(404);
  });

  it('404s an unknown slug', async () => {
    await request(app).get('/api/event/no-such-event-anywhere').expect(404);
  });

  it('answers 200 with canBuy=false for a finished event', async () => {
    const event = await createEvent({
      startsAt: new Date(Date.now() - 5 * HOUR),
      endsAt: new Date(Date.now() - HOUR),
    });
    await addTicketType(event.id, {});

    const res = await request(app).get(`/api/event/${event.slug}`).expect(200);
    expect(res.body.data.canBuy).toBe(false);
    expect(res.body.data.ticketTypes).toHaveLength(1);
  });

  it('answers 200 with canBuy=false for a CLOSED or CANCELED event', async () => {
    for (const status of ['CLOSED', 'CANCELED']) {
      const event = await createEvent({ status });
      await addTicketType(event.id, {});
      const res = await request(app).get(`/api/event/${event.slug}`).expect(200);
      expect(res.body.data.canBuy).toBe(false);
      expect(res.body.data.status).toBe(status);
    }
  });

  it('keeps a sold-out ticket type visible but not buyable', async () => {
    const event = await createEvent({});
    const type = await addTicketType(event.id, { quota: 3 });
    await occupySeats(type.id, 3, 'ISSUED');

    const res = await request(app).get(`/api/event/${event.slug}`).expect(200);
    const [ticket] = res.body.data.ticketTypes;

    expect(ticket.isSoldOut).toBe(true);
    expect(ticket.isOnSale).toBe(false);
    expect(ticket.remainingQuota).toBe(0);
    expect(res.body.data.canBuy).toBe(false);
  });

  it('leaves canBuy true while at least one type is still sellable', async () => {
    const event = await createEvent({});
    const soldOut = await addTicketType(event.id, { name: 'Offline', quota: 1, sortOrder: 0 });
    await occupySeats(soldOut.id, 1, 'ISSUED');
    await addTicketType(event.id, { name: 'Online', quota: 5, sortOrder: 1 });

    const res = await request(app).get(`/api/event/${event.slug}`).expect(200);
    expect(res.body.data.canBuy).toBe(true);
    expect(res.body.data.ticketTypes.map((t: { isOnSale: boolean }) => t.isOnSale)).toEqual([
      false,
      true,
    ]);
  });

  it('hides an inactive ticket type entirely', async () => {
    const event = await createEvent({});
    await addTicketType(event.id, { name: 'Online', isActive: true });
    await addTicketType(event.id, { name: 'Retired', isActive: false });

    const res = await request(app).get(`/api/event/${event.slug}`).expect(200);
    expect(res.body.data.ticketTypes).toHaveLength(1);
    expect(res.body.data.ticketTypes[0].name).toBe('Online');
  });

  it('reports an unlimited ticket type as null quota, never sold out', async () => {
    const event = await createEvent({});
    const type = await addTicketType(event.id, { quota: null });
    await occupySeats(type.id, 50, 'ISSUED');

    const res = await request(app).get(`/api/event/${event.slug}`).expect(200);
    expect(res.body.data.ticketTypes[0].remainingQuota).toBeNull();
    expect(res.body.data.ticketTypes[0].isSoldOut).toBe(false);
  });
});
