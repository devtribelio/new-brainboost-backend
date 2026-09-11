import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { prisma } from '@bb/db';
import { commerceEvents } from '@bb/common/events/commerce-events';
import { claimTicketsByEmail } from '@bb/domain/event/claim';
import { trackingLinkService } from '@bb/domain/shop/tracking-link.service';
import { registerEventTicketListeners } from '@bb/domain/event/listeners/ticket-issue.listener';

const HOUR = 3600 * 1000;
const created = {
  events: [] as string[],
  products: [] as string[],
  members: [] as string[],
  links: [] as string[],
};

beforeAll(() => {
  registerEventTicketListeners();
});

async function seedTicket(opts: { attendeeEmail: string; status?: string }) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const event = await prisma.event.create({
    data: {
      slug: `claim-event-${suffix}`,
      title: `Claim Event ${suffix}`,
      startsAt: new Date(Date.now() + 48 * HOUR),
      status: 'ON_SALE',
    },
  });
  created.events.push(event.id);

  const product = await prisma.product.create({
    data: {
      type: 'event_ticket',
      title: `Ticket ${suffix}`,
      code: `EVT-${suffix.slice(-8)}`,
      price: 100000,
      isActive: true,
    },
  });
  created.products.push(product.id);

  const type = await prisma.eventTicketType.create({
    data: { eventId: event.id, productId: product.id, name: 'Online', kind: 'ONLINE', quota: 10 },
  });

  const buyer = await prisma.member.create({
    data: { email: `claim-buyer-${suffix}@test.local`, passwordHash: 'x', fullName: 'Buyer' },
  });
  created.members.push(buyer.id);

  const tx = await prisma.commerceTransaction.create({
    data: {
      code: `TEST-CLM-${suffix}`,
      memberId: buyer.id,
      productId: product.id,
      qty: 1,
      itemTotal: 100000,
      amount: 100000,
      status: 'PAID',
      paidAt: new Date(),
    },
  });

  const ticket = await prisma.eventTicket.create({
    data: {
      code: `BBT-${suffix.slice(-4)}${Math.floor(Math.random() * 90 + 10)}`,
      ticketTypeId: type.id,
      transactionId: tx.id,
      buyerMemberId: buyer.id,
      attendeeName: 'Peserta',
      attendeeEmail: opts.attendeeEmail,
      status: opts.status ?? 'ISSUED',
    },
  });

  return { event, product, ticket, tx, buyer };
}

afterEach(async () => {
  await prisma.trackingLinkClick.deleteMany({ where: { linkId: { in: created.links } } });
  await prisma.trackingLink.deleteMany({ where: { id: { in: created.links } } });
  await prisma.eventTicket.deleteMany({ where: { buyerMemberId: { in: created.members } } });
  await prisma.commerceTransaction.deleteMany({ where: { memberId: { in: created.members } } });
  await prisma.eventTicketType.deleteMany({ where: { eventId: { in: created.events } } });
  await prisma.event.deleteMany({ where: { id: { in: created.events } } });
  await prisma.product.deleteMany({ where: { id: { in: created.products } } });
  await prisma.member.deleteMany({ where: { id: { in: created.members } } });
  created.events = [];
  created.products = [];
  created.members = [];
  created.links = [];
});

describe('claimTicketsByEmail', () => {
  it('binds ISSUED tickets addressed to the verified email', async () => {
    const attendeeEmail = `attendee-${Date.now()}@test.local`;
    const { ticket } = await seedTicket({ attendeeEmail });
    const attendee = await prisma.member.create({
      data: { email: attendeeEmail, passwordHash: 'x', fullName: 'Attendee' },
    });
    created.members.push(attendee.id);

    const claimed = await claimTicketsByEmail(attendee.id, attendeeEmail);

    expect(claimed).toBe(1);
    expect((await prisma.eventTicket.findUnique({ where: { id: ticket.id } }))!.memberId).toBe(
      attendee.id,
    );
  });

  it('is idempotent — a second verification claims nothing', async () => {
    const attendeeEmail = `again-${Date.now()}@test.local`;
    await seedTicket({ attendeeEmail });
    const attendee = await prisma.member.create({
      data: { email: attendeeEmail, passwordHash: 'x', fullName: 'Attendee' },
    });
    created.members.push(attendee.id);

    expect(await claimTicketsByEmail(attendee.id, attendeeEmail)).toBe(1);
    expect(await claimTicketsByEmail(attendee.id, attendeeEmail)).toBe(0);
  });

  it('never reassigns a ticket already claimed by someone else', async () => {
    const attendeeEmail = `taken-${Date.now()}@test.local`;
    const { ticket } = await seedTicket({ attendeeEmail });
    const first = await prisma.member.create({
      data: { email: attendeeEmail, passwordHash: 'x', fullName: 'First' },
    });
    const second = await prisma.member.create({
      data: { email: `other-${Date.now()}@test.local`, passwordHash: 'x', fullName: 'Second' },
    });
    created.members.push(first.id, second.id);

    await claimTicketsByEmail(first.id, attendeeEmail);
    await claimTicketsByEmail(second.id, attendeeEmail);

    expect((await prisma.eventTicket.findUnique({ where: { id: ticket.id } }))!.memberId).toBe(
      first.id,
    );
  });

  it('ignores a RESERVED ticket — its order may still expire', async () => {
    const attendeeEmail = `reserved-${Date.now()}@test.local`;
    await seedTicket({ attendeeEmail, status: 'RESERVED' });
    const attendee = await prisma.member.create({
      data: { email: attendeeEmail, passwordHash: 'x', fullName: 'Attendee' },
    });
    created.members.push(attendee.id);

    expect(await claimTicketsByEmail(attendee.id, attendeeEmail)).toBe(0);
  });

  it('matches case-insensitively', async () => {
    const attendeeEmail = `case-${Date.now()}@test.local`;
    await seedTicket({ attendeeEmail });
    const attendee = await prisma.member.create({
      data: { email: attendeeEmail, passwordHash: 'x', fullName: 'Attendee' },
    });
    created.members.push(attendee.id);

    expect(await claimTicketsByEmail(attendee.id, attendeeEmail.toUpperCase())).toBe(1);
  });
});

describe('refund voids tickets', () => {
  it('flips ISSUED tickets to VOID and gives the seat back', async () => {
    const { ticket, tx, buyer } = await seedTicket({ attendeeEmail: `ref-${Date.now()}@test.local` });

    commerceEvents.emit('commerce.payment.refunded', {
      transactionId: tx.id,
      memberId: buyer.id,
      productId: null,
    });
    await new Promise((r) => setTimeout(r, 250));

    const after = await prisma.eventTicket.findUnique({ where: { id: ticket.id } });
    expect(after!.status).toBe('VOID');
    // Quota counts RESERVED + ISSUED, so a VOID seat is back on sale.
    expect(
      await prisma.eventTicket.count({
        where: { ticketTypeId: after!.ticketTypeId, status: { in: ['RESERVED', 'ISSUED'] } },
      }),
    ).toBe(0);
  });
});

describe('shortlink resolves an event ticket to its event page', () => {
  async function makeLink(productId: string, slugSuffix: string) {
    const link = await prisma.trackingLink.create({
      data: {
        name: `Webinar ${slugSuffix}`,
        slug: `webinar-${slugSuffix}`,
        productId,
        utmSource: 'instagram',
        utmCampaign: `sep-${slugSuffix}`,
      },
    });
    created.links.push(link.id);
    return link;
  }

  it('points at /event/<slug>, not /product/<code>', async () => {
    const suffix = `${Date.now()}`;
    const { event, product } = await seedTicket({ attendeeEmail: `sl-${suffix}@test.local` });
    const link = await makeLink(product.id, suffix);

    const target = await trackingLinkService.resolve(link.slug);

    expect(target.linkId).toBe(link.id);
    expect(target.url).toContain(`/event/${event.slug}`);
    expect(target.url).not.toContain('/product/');
    // The UTM query is unchanged — attribution must survive the new path.
    expect(target.url).toContain('utm_source=instagram');
    expect(target.url).toContain(`utm_campaign=sep-${suffix}`);
  });

  it('still points a normal course product at /product/<code>', async () => {
    const suffix = `${Date.now()}-course`;
    const product = await prisma.product.create({
      data: { type: 'course', title: 'A Course', code: `CRS-${Date.now()}`, price: 1, isActive: true },
    });
    created.products.push(product.id);
    const link = await makeLink(product.id, suffix);

    const target = await trackingLinkService.resolve(link.slug);

    expect(target.url).toContain(`/product/${product.code}`);
    expect(target.url).not.toContain('/event/');
  });
});
