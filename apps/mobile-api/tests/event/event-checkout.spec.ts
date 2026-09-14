import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { SETTING_KEYS, SettingsService } from '@bb/common/services/settings.service';
import type { XenditGateway } from '@bb/common/services/xendit-gateway';
import type { CreateInvoiceRequest, Invoice } from 'xendit-node/invoice/models';
import { PaymentService } from '@bb/domain/commerce/payment.service';
import { CheckoutService } from '@bb/domain/commerce/checkout.service';
import { EventCheckoutService } from '@bb/domain/event/event-checkout.service';
import { buildApp } from '../../src/app';

const app = buildApp();
const HOUR = 3600 * 1000;

const created = { events: [] as string[], products: [] as string[], members: [] as string[] };

function mockGateway(): XenditGateway {
  return {
    createInvoice: async (params: CreateInvoiceRequest): Promise<Invoice> =>
      ({
        id: `inv-${Math.random().toString(36).slice(2, 12)}`,
        externalId: params.externalId,
        status: 'PENDING',
        amount: params.amount,
        invoiceUrl: 'https://checkout-staging.xendit.co/web/0193abc',
      }) as unknown as Invoice,
    expireInvoice: async () => ({}) as Invoice,
  };
}

function service(): EventCheckoutService {
  return new EventCheckoutService(new CheckoutService(), new PaymentService(mockGateway()));
}

async function createTicketType(opts: { price?: number; quota?: number | null; maxPerOrder?: number; eventStatus?: string } = {}) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const event = await prisma.event.create({
    data: {
      slug: `checkout-event-${suffix}`,
      title: `Checkout Event ${suffix}`,
      startsAt: new Date(Date.now() + 48 * HOUR),
      endsAt: new Date(Date.now() + 50 * HOUR),
      status: opts.eventStatus ?? 'ON_SALE',
    },
  });
  created.events.push(event.id);

  const product = await prisma.product.create({
    data: {
      type: 'event_ticket',
      title: `Ticket ${suffix}`,
      price: opts.price ?? 150000,
      isActive: true,
      status: 'active',
    },
  });
  created.products.push(product.id);

  const type = await prisma.eventTicketType.create({
    data: {
      eventId: event.id,
      productId: product.id,
      name: 'Online',
      kind: 'ONLINE',
      quota: opts.quota === undefined ? 10 : opts.quota,
      maxPerOrder: opts.maxPerOrder ?? 10,
    },
  });
  return { event, product, type };
}

function attendee(n: number) {
  return { name: `Peserta ${n}`, email: `peserta${n}-${Date.now()}@test.local` };
}

function track(memberId: string) {
  created.members.push(memberId);
  return memberId;
}

afterEach(async () => {
  await prisma.eventTicket.deleteMany({ where: { ticketType: { eventId: { in: created.events } } } });
  await prisma.commercePaymentEvent.deleteMany({
    where: { payment: { memberId: { in: created.members } } },
  });
  await prisma.commercePayment.deleteMany({ where: { memberId: { in: created.members } } });
  await prisma.commerceTransaction.deleteMany({ where: { memberId: { in: created.members } } });
  await prisma.eventTicketType.deleteMany({ where: { eventId: { in: created.events } } });
  await prisma.event.deleteMany({ where: { id: { in: created.events } } });
  await prisma.product.deleteMany({ where: { id: { in: created.products } } });
  await prisma.member.deleteMany({ where: { id: { in: created.members } } });
  created.events = [];
  created.products = [];
  created.members = [];
});

describe('EventCheckoutService.start — guest checkout', () => {
  it('creates a placeholder member, an order of qty N, and N RESERVED tickets', async () => {
    const { type, product } = await createTicketType({ price: 150000 });
    const buyerEmail = `buyer-${Date.now()}@test.local`;

    const result = await service().start({
      ticketTypeId: type.id,
      buyer: { name: 'Rina', email: buyerEmail, phone: '081234567890' },
      attendees: [attendee(1), attendee(2)],
    });

    const member = await prisma.member.findUnique({ where: { email: buyerEmail } });
    expect(member).not.toBeNull();
    track(member!.id);
    // A placeholder grants no access on its own — that is what makes attaching
    // an order to a stranger's email harmless.
    expect(member!.isActive).toBe(false);
    expect(member!.isEmailVerified).toBe(false);
    expect(member!.passwordAlgo).toBe('social');

    const tx = await prisma.commerceTransaction.findUnique({
      where: { id: result.transactionId },
    });
    expect(tx!.qty).toBe(2);
    expect(tx!.itemTotal).toBe(300000);
    expect(tx!.amount).toBe(300000);
    expect(tx!.productId).toBe(product.id);
    expect(tx!.memberId).toBe(member!.id);

    const tickets = await prisma.eventTicket.findMany({ where: { transactionId: tx!.id } });
    expect(tickets).toHaveLength(2);
    expect(tickets.every((t) => t.status === 'RESERVED')).toBe(true);
    expect(tickets.every((t) => /^BBT-[A-Z2-9]{6}$/.test(t.code))).toBe(true);
    expect(result.payment.invoiceUrl).toContain('xendit.co');
  });

  it("stores each attendee's own phone in E.164, and null when none is sent", async () => {
    const { type } = await createTicketType({ price: 0 });
    const email = `att-phone-${Date.now()}@test.local`;

    const result = await service().start({
      ticketTypeId: type.id,
      buyer: { name: 'Rina', email },
      attendees: [
        { ...attendee(1), phone: '081234567890' },
        { ...attendee(2), phone: '91234567', phoneCode: '+65' },
        attendee(3),
      ],
    });
    track((await prisma.member.findUnique({ where: { email } }))!.id);

    const tickets = await prisma.eventTicket.findMany({
      where: { transactionId: result.transactionId },
      orderBy: { createdAt: 'asc' },
      select: { attendeePhone: true },
    });
    // Full E.164, unlike members.phone / buyer_phone: this column has no COALESCE
    // partner and no lookup, so the dialable form is the useful one.
    expect(tickets.map((t) => t.attendeePhone)).toEqual(['+6281234567890', '+6591234567', null]);
  });

  it('drops an unusable attendee phone rather than failing the sale', async () => {
    const { type } = await createTicketType({ price: 0 });
    const email = `att-badphone-${Date.now()}@test.local`;

    const result = await service().start({
      ticketTypeId: type.id,
      buyer: { name: 'Rina', email },
      attendees: [{ ...attendee(1), phone: '   ' }],
    });
    track((await prisma.member.findUnique({ where: { email } }))!.id);

    const ticket = await prisma.eventTicket.findFirst({
      where: { transactionId: result.transactionId },
      select: { attendeePhone: true },
    });
    expect(ticket!.attendeePhone).toBeNull();
  });

  it('reuses an existing member for the same email instead of creating a second one', async () => {
    const { type } = await createTicketType({});
    const email = `existing-${Date.now()}@test.local`;
    const existing = await prisma.member.create({
      data: { email, passwordHash: 'x', fullName: 'Existing', isActive: true },
    });
    track(existing.id);

    const result = await service().start({
      ticketTypeId: type.id,
      buyer: { name: 'Someone Else', email },
      attendees: [attendee(1)],
    });

    const tx = await prisma.commerceTransaction.findUnique({ where: { id: result.transactionId } });
    expect(tx!.memberId).toBe(existing.id);
    expect(await prisma.member.count({ where: { email } })).toBe(1);
  });

  it('issues one ticket per attendee even when every email is the same', async () => {
    const { type } = await createTicketType({});
    const email = `same-${Date.now()}@test.local`;

    const result = await service().start({
      ticketTypeId: type.id,
      buyer: { name: 'Rina', email },
      attendees: [
        { name: 'Rina', email },
        { name: 'Rina', email },
        { name: 'Rina', email },
      ],
    });
    track((await prisma.member.findUnique({ where: { email } }))!.id);

    const tickets = await prisma.eventTicket.findMany({ where: { transactionId: result.transactionId } });
    expect(tickets).toHaveLength(3);
    expect(new Set(tickets.map((t) => t.code)).size).toBe(3);
  });

  it('freezes the UTM snapshot on the order', async () => {
    const { type } = await createTicketType({});
    const email = `utm-${Date.now()}@test.local`;

    const result = await service().start({
      ticketTypeId: type.id,
      buyer: { name: 'Rina', email },
      attendees: [attendee(1)],
      source: { guestId: 'guest-1', utmSource: 'instagram', utmCampaign: 'webinar-sep' },
    });
    track((await prisma.member.findUnique({ where: { email } }))!.id);

    const tx = await prisma.commerceTransaction.findUnique({ where: { id: result.transactionId } });
    expect(tx!.utmSource).toBe('instagram');
    expect(tx!.utmCampaign).toBe('webinar-sep');
    expect(tx!.guestId).toBe('guest-1');
  });

  it('attaches the order to the logged-in member and ignores the buyer block', async () => {
    const { type } = await createTicketType({});
    const member = await prisma.member.create({
      data: { email: `logged-${Date.now()}@test.local`, passwordHash: 'x', fullName: 'Logged In' },
    });
    track(member.id);

    const result = await service().start({
      ticketTypeId: type.id,
      memberId: member.id,
      buyer: { name: 'Ignored', email: `ignored-${Date.now()}@test.local` },
      attendees: [attendee(1)],
    });

    const tx = await prisma.commerceTransaction.findUnique({ where: { id: result.transactionId } });
    expect(tx!.memberId).toBe(member.id);
  });
});

describe('EventCheckoutService.start — buyer phone', () => {
  it('freezes the typed number on the order', async () => {
    const { type } = await createTicketType({ price: 0 });
    const email = `phone-${Date.now()}@test.local`;

    const result = await service().start({
      ticketTypeId: type.id,
      buyer: { name: 'Rina', email, phone: '081234567890' },
      attendees: [attendee(1)],
    });
    track((await prisma.member.findUnique({ where: { email } }))!.id);

    const tx = await prisma.commerceTransaction.findUnique({ where: { id: result.transactionId } });
    expect(tx!.buyerPhone).toBe('81234567890');
  });

  it('keeps the number even for a logged-in buyer, whose buyer block is otherwise ignored', async () => {
    const { type } = await createTicketType({ price: 0 });
    const member = await prisma.member.create({
      data: { email: `logged-phone-${Date.now()}@test.local`, passwordHash: 'x', fullName: 'Logged' },
    });
    track(member.id);

    const result = await service().start({
      ticketTypeId: type.id,
      memberId: member.id,
      buyer: { name: 'Ignored', email: 'ignored@test.local', phone: '081298765432' },
      attendees: [attendee(1)],
    });

    const tx = await prisma.commerceTransaction.findUnique({ where: { id: result.transactionId } });
    expect(tx!.buyerPhone).toBe('81298765432');
    // And the empty profile gets filled — unverified, so it cannot be used to
    // recover the account.
    const after = await prisma.member.findUnique({ where: { id: member.id } });
    expect(after!.phone).toBe('81298765432');
    expect(after!.isPhoneVerified).toBe(false);
  });

  it("keeps the member's own number and ignores the one typed", async () => {
    const { type } = await createTicketType({ price: 0 });
    const original = `8100${Date.now().toString().slice(-7)}`;
    const member = await prisma.member.create({
      data: {
        email: `has-phone-${Date.now()}@test.local`,
        passwordHash: 'x',
        fullName: 'Has Phone',
        phone: original,
      },
    });
    track(member.id);

    const result = await service().start({
      ticketTypeId: type.id,
      memberId: member.id,
      buyer: { name: 'X', email: 'x@test.local', phone: '081211112222' },
      attendees: [attendee(1)],
    });

    // Profile untouched, and the order records the profile's number — a checkout
    // form does not get to decide which number the organiser is given.
    expect((await prisma.member.findUnique({ where: { id: member.id } }))!.phone).toBe(original);
    const tx = await prisma.commerceTransaction.findUnique({ where: { id: result.transactionId } });
    expect(tx!.buyerPhone).toBe(original);
  });

  it('stamps the dial code that was sent, so a foreign number stays dialable', async () => {
    const { type } = await createTicketType({ price: 0 });
    const member = await prisma.member.create({
      data: { email: `foreign-${Date.now()}@test.local`, passwordHash: 'x', fullName: 'Foreign' },
    });
    track(member.id);

    await service().start({
      ticketTypeId: type.id,
      memberId: member.id,
      buyer: { name: 'X', email: 'x@test.local', phone: '91234567', phoneCode: '+65' },
      attendees: [attendee(1)],
    });

    // Without the code the number is stored as Indonesian and `otpPhoneTarget`
    // rebuilds it as +6591234567 — a number that does not exist.
    const after = await prisma.member.findUnique({ where: { id: member.id } });
    expect(after!.phone).toBe('91234567');
    expect(after!.phoneCode).toBe('+65');
  });

  it('defaults the dial code to +62 when none is sent', async () => {
    const { type } = await createTicketType({ price: 0 });
    const member = await prisma.member.create({
      data: { email: `nocode-${Date.now()}@test.local`, passwordHash: 'x', fullName: 'No Code' },
    });
    track(member.id);

    await service().start({
      ticketTypeId: type.id,
      memberId: member.id,
      buyer: { name: 'X', email: 'x@test.local', phone: '081233334444' },
      attendees: [attendee(1)],
    });

    const after = await prisma.member.findUnique({ where: { id: member.id } });
    expect(after!.phone).toBe('81233334444');
    // NOT the empty string: `phoneCode ?? '+62'` at the read end would not catch it.
    expect(after!.phoneCode).toBe('+62');
  });
});

describe('EventCheckoutService.start — buyer email', () => {
  // A member who registered by phone has members.email = NULL. Before the order
  // carried its own address, their summary email was rejected into the DLQ and
  // their order page answered 404 to the person who had just paid — both
  // silently, because the tickets themselves go to the attendee addresses and
  // arrived fine.
  it('takes the typed email when the account has none', async () => {
    const { type } = await createTicketType({ price: 0 });
    const member = await prisma.member.create({
      data: {
        email: null,
        phone: `8155${Date.now().toString().slice(-7)}`,
        passwordHash: 'x',
        fullName: 'Phone Only',
      },
    });
    track(member.id);
    const typed = `typed-${Date.now()}@test.local`;

    const result = await service().start({
      ticketTypeId: type.id,
      memberId: member.id,
      buyer: { name: 'X', email: typed, phone: '081200000000' },
      attendees: [attendee(1)],
    });

    const tx = await prisma.commerceTransaction.findUnique({ where: { id: result.transactionId } });
    expect(tx!.buyerEmail).toBe(typed);
    // And the account's identity is untouched — an email typed into a checkout
    // form must never become the login handle.
    expect((await prisma.member.findUnique({ where: { id: member.id } }))!.email).toBeNull();
  });

  it("keeps the account's email and ignores the one typed", async () => {
    const { type } = await createTicketType({ price: 0 });
    const account = `acct-wins-${Date.now()}@test.local`;
    const member = await prisma.member.create({
      data: { email: account, passwordHash: 'x', fullName: 'Has Email' },
    });
    track(member.id);

    const result = await service().start({
      ticketTypeId: type.id,
      memberId: member.id,
      buyer: { name: 'X', email: `typed-${Date.now()}@test.local` },
      attendees: [attendee(1)],
    });

    // A checkout form must not redirect where this member's receipts go.
    const tx = await prisma.commerceTransaction.findUnique({ where: { id: result.transactionId } });
    expect(tx!.buyerEmail).toBe(account);
    expect((await prisma.member.findUnique({ where: { id: member.id } }))!.email).toBe(account);
  });

  it("falls back to the account's email when none is typed", async () => {
    const { type } = await createTicketType({ price: 0 });
    const email = `acct-${Date.now()}@test.local`;
    const member = await prisma.member.create({
      data: { email, passwordHash: 'x', fullName: 'Has Email' },
    });
    track(member.id);

    const result = await service().start({
      ticketTypeId: type.id,
      memberId: member.id,
      attendees: [attendee(1)],
    });

    const tx = await prisma.commerceTransaction.findUnique({ where: { id: result.transactionId } });
    expect(tx!.buyerEmail).toBe(email);
  });

  it('opens the order page for a payer whose account has no email', async () => {
    const { type } = await createTicketType({ price: 0 });
    const member = await prisma.member.create({
      data: {
        email: null,
        phone: `8156${Date.now().toString().slice(-7)}`,
        passwordHash: 'x',
        fullName: 'Phone Only',
      },
    });
    track(member.id);
    const typed = `page-${Date.now()}@test.local`;

    const checkout = await service().start({
      ticketTypeId: type.id,
      memberId: member.id,
      buyer: { name: 'X', email: typed, phone: '081200000001' },
      attendees: [attendee(1)],
    });

    const res = await request(app)
      .get(`/api/event/order/${checkout.transactionCode}`)
      .query({ email: typed })
      .expect(200);
    expect(res.body.data.tickets).toHaveLength(1);
  });
});

describe('EventCheckoutService.start — payment window', () => {
  it('gives the buyer the configured minutes, not the 24h course window', async () => {
    const { type } = await createTicketType({ price: 150000 });
    const email = `window-${Date.now()}@test.local`;

    const before = Date.now();
    const result = await service().start({
      ticketTypeId: type.id,
      buyer: { name: 'Rina', email },
      attendees: [attendee(1)],
    });
    track((await prisma.member.findUnique({ where: { email } }))!.id);

    const minutes = (result.expiredAt.getTime() - before) / 60000;
    // 30 by default. Anything near 1440 would mean the course window leaked in
    // and a seat is held overnight.
    expect(minutes).toBeGreaterThan(25);
    expect(minutes).toBeLessThan(35);
  });

  it('never lets the Xendit invoice outlive the order it pays for', async () => {
    const { type } = await createTicketType({ price: 150000 });
    const email = `invoice-${Date.now()}@test.local`;

    const result = await service().start({
      ticketTypeId: type.id,
      buyer: { name: 'Rina', email },
      attendees: [attendee(1)],
    });
    track((await prisma.member.findUnique({ where: { email } }))!.id);

    const payment = await prisma.commercePayment.findUnique({
      where: { id: result.payment.paymentId },
      select: { expiredAt: true },
    });
    // If the invoice outlived the order, a buyer could pay after the sweeper
    // released their seats: the webhook still emits payment success, the ticket
    // flip matches zero RESERVED rows, and the money is taken with nothing
    // issued and no error raised anywhere.
    expect(payment!.expiredAt!.getTime()).toBeLessThanOrEqual(result.expiredAt.getTime());
  });
});

describe('EventCheckoutService.start — free tickets', () => {
  it('settles a price-0 ticket without Xendit', async () => {
    const { type } = await createTicketType({ price: 0 });
    const email = `free-${Date.now()}@test.local`;

    const result = await service().start({
      ticketTypeId: type.id,
      buyer: { name: 'Rina', email },
      attendees: [attendee(1)],
    });
    track((await prisma.member.findUnique({ where: { email } }))!.id);

    expect(result.amount).toBe(0);
    expect(result.payment.status).toBe('SUCCESS');
    expect(result.payment.invoiceUrl).toBeNull();

    const tx = await prisma.commerceTransaction.findUnique({ where: { id: result.transactionId } });
    expect(tx!.status).toBe('PAID');
  });
});

describe('EventCheckoutService.start — quota', () => {
  it('lets exactly one of two concurrent buyers take the last seat', async () => {
    const { type } = await createTicketType({ quota: 1 });
    const emailA = `race-a-${Date.now()}@test.local`;
    const emailB = `race-b-${Date.now()}@test.local`;

    const results = await Promise.allSettled([
      service().start({
        ticketTypeId: type.id,
        buyer: { name: 'A', email: emailA },
        attendees: [attendee(1)],
      }),
      service().start({
        ticketTypeId: type.id,
        buyer: { name: 'B', email: emailB },
        attendees: [attendee(2)],
      }),
    ]);
    for (const email of [emailA, emailB]) {
      const m = await prisma.member.findUnique({ where: { email } });
      if (m) track(m.id);
    }

    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'EVENT_TICKET_SOLD_OUT',
    });

    const tickets = await prisma.eventTicket.findMany({ where: { ticketTypeId: type.id } });
    expect(tickets).toHaveLength(1);
  });

  it('refuses an order that would exceed the remaining quota as a whole', async () => {
    const { type } = await createTicketType({ quota: 2 });
    const email = `bulk-${Date.now()}@test.local`;

    await expect(
      service().start({
        ticketTypeId: type.id,
        buyer: { name: 'Rina', email },
        attendees: [attendee(1), attendee(2), attendee(3)],
      }),
    ).rejects.toMatchObject({ code: 'EVENT_TICKET_SOLD_OUT' });

    const m = await prisma.member.findUnique({ where: { email } });
    if (m) track(m.id);
    expect(await prisma.eventTicket.count({ where: { ticketTypeId: type.id } })).toBe(0);
  });

  it('leaves no PENDING order behind when the seats could not be taken', async () => {
    const { type } = await createTicketType({ quota: 1 });
    const email = `orphan-${Date.now()}@test.local`;
    const first = await service().start({
      ticketTypeId: type.id,
      buyer: { name: 'First', email: `first-${Date.now()}@test.local` },
      attendees: [attendee(1)],
    });
    const firstTx = await prisma.commerceTransaction.findUnique({ where: { id: first.transactionId } });
    track(firstTx!.memberId);

    await expect(
      service().start({
        ticketTypeId: type.id,
        buyer: { name: 'Second', email },
        attendees: [attendee(2)],
      }),
    ).rejects.toMatchObject({ code: 'EVENT_TICKET_SOLD_OUT' });

    const loser = await prisma.member.findUnique({ where: { email } });
    track(loser!.id);
    const orders = await prisma.commerceTransaction.findMany({ where: { memberId: loser!.id } });
    expect(orders).toHaveLength(1);
    expect(orders[0].status).toBe('CANCELED');
  });

  it('sells without limit when quota is null', async () => {
    const { type } = await createTicketType({ quota: null, maxPerOrder: 10 });
    const email = `unlimited-${Date.now()}@test.local`;

    const result = await service().start({
      ticketTypeId: type.id,
      buyer: { name: 'Rina', email },
      attendees: Array.from({ length: 10 }, (_, i) => attendee(i)),
    });
    track((await prisma.member.findUnique({ where: { email } }))!.id);

    expect(result.tickets).toHaveLength(10);
  });
});

describe('EventCheckoutService.start — rejections', () => {
  it('rejects more tickets than maxPerOrder', async () => {
    const { type } = await createTicketType({ maxPerOrder: 2 });

    await expect(
      service().start({
        ticketTypeId: type.id,
        buyer: { name: 'Rina', email: `qty-${Date.now()}@test.local` },
        attendees: [attendee(1), attendee(2), attendee(3)],
      }),
    ).rejects.toMatchObject({ code: 'EVENT_TICKET_QTY_INVALID' });
  });

  it('rejects an empty attendee list', async () => {
    const { type } = await createTicketType({});

    await expect(
      service().start({
        ticketTypeId: type.id,
        buyer: { name: 'Rina', email: `empty-${Date.now()}@test.local` },
        attendees: [],
      }),
    ).rejects.toMatchObject({ code: 'EVENT_TICKET_QTY_INVALID' });
  });

  it('rejects an attendee with a missing name or malformed email', async () => {
    const { type } = await createTicketType({});
    const buyer = { name: 'Rina', email: `att-${Date.now()}@test.local` };

    await expect(
      service().start({ ticketTypeId: type.id, buyer, attendees: [{ name: '', email: 'a@b.co' }] }),
    ).rejects.toMatchObject({ code: 'EVENT_ATTENDEE_INVALID' });

    await expect(
      service().start({ ticketTypeId: type.id, buyer, attendees: [{ name: 'X', email: 'not-an-email' }] }),
    ).rejects.toMatchObject({ code: 'EVENT_ATTENDEE_INVALID' });
  });

  it('rejects a ticket type whose event is not ON_SALE', async () => {
    const { type } = await createTicketType({ eventStatus: 'CLOSED' });

    await expect(
      service().start({
        ticketTypeId: type.id,
        buyer: { name: 'Rina', email: `closed-${Date.now()}@test.local` },
        attendees: [attendee(1)],
      }),
    ).rejects.toMatchObject({ code: 'EVENT_NOT_ON_SALE' });
  });

  it('rejects a TRIAL voucher — it grants course access, not a seat', async () => {
    const { type, product } = await createTicketType({});
    const voucher = await prisma.voucher.create({
      data: {
        code: `TRIAL-${Date.now()}`,
        type: 'TRIAL',
        value: 0,
        trialDays: 7,
        quota: 100,
        isActive: true,
        products: { create: { productId: product.id } },
      },
    });

    await expect(
      service().start({
        ticketTypeId: type.id,
        buyer: { name: 'Rina', email: `trial-${Date.now()}@test.local` },
        attendees: [attendee(1)],
        voucherCode: voucher.code,
      }),
    ).rejects.toMatchObject({ code: 'VOUCHER_INVALID' });

    await prisma.voucherProduct.deleteMany({ where: { voucherId: voucher.id } });
    await prisma.voucher.delete({ where: { id: voucher.id } });
  });
});

describe('POST /api/event/checkout', () => {
  it('completes a free-ticket checkout over HTTP with no auth', async () => {
    const { type } = await createTicketType({ price: 0 });
    const email = `http-${Date.now()}@test.local`;

    const res = await request(app)
      .post('/api/event/checkout')
      .send({
        ticketTypeId: type.id,
        buyer: { name: 'Rina Kusuma', email, phone: '081234567890' },
        attendees: [{ name: 'Rina Kusuma', email }],
        source: { guestId: 'g-1', utmSource: 'instagram' },
      })
      .expect(201);

    track((await prisma.member.findUnique({ where: { email } }))!.id);
    expect(res.body.data.tickets).toHaveLength(1);
    expect(res.body.data.payment.status).toBe('SUCCESS');
    expect(res.body.data.payment.invoiceUrl).toBeNull();
  });

  it('rejects a malformed body before it reaches the database', async () => {
    const { type } = await createTicketType({ price: 0 });

    await request(app)
      .post('/api/event/checkout')
      .send({ ticketTypeId: type.id, attendees: [{ name: 'X', email: 'nope' }] })
      .expect(400);
  });
});

describe('GET /api/event/order/:code', () => {
  it('returns the order, its tickets and the invoice link while pending', async () => {
    const { type } = await createTicketType({ price: 150000 });
    const email = `order-${Date.now()}@test.local`;

    const checkout = await service().start({
      ticketTypeId: type.id,
      buyer: { name: 'Rina', email },
      attendees: [attendee(1), attendee(2)],
    });
    track((await prisma.member.findUnique({ where: { email } }))!.id);

    const res = await request(app)
      .get(`/api/event/order/${checkout.transactionCode}`)
      .query({ email })
      .expect(200);

    expect(res.body.data.status).toBe('PENDING');
    expect(res.body.data.tickets).toHaveLength(2);
    expect(res.body.data.invoiceUrl).toContain('xendit.co');
    expect(res.body.data.ticketTypeName).toBe('Online');
    expect(res.body.data.event.slug).toBeDefined();
  });

  it('404s a wrong email rather than 403 — a 403 would confirm the code exists', async () => {
    const { type } = await createTicketType({ price: 0 });
    const email = `owner-${Date.now()}@test.local`;

    const checkout = await service().start({
      ticketTypeId: type.id,
      buyer: { name: 'Rina', email },
      attendees: [attendee(1)],
    });
    track((await prisma.member.findUnique({ where: { email } }))!.id);

    await request(app)
      .get(`/api/event/order/${checkout.transactionCode}`)
      .query({ email: 'someone-else@test.local' })
      .expect(404);
  });

  it('404s an unknown order code', async () => {
    await request(app)
      .get('/api/event/order/BB-00000000-9999')
      .query({ email: 'nobody@test.local' })
      .expect(404);
  });

  it('rejects a request carrying no credential at all', async () => {
    await request(app).get('/api/event/order/BB-00000000-9999').expect(400);
  });

  it('drops the invoice link once the order is settled', async () => {
    const { type } = await createTicketType({ price: 0 });
    const email = `settled-${Date.now()}@test.local`;

    const checkout = await service().start({
      ticketTypeId: type.id,
      buyer: { name: 'Rina', email },
      attendees: [attendee(1)],
    });
    track((await prisma.member.findUnique({ where: { email } }))!.id);

    const res = await request(app)
      .get(`/api/event/order/${checkout.transactionCode}`)
      .query({ email })
      .expect(200);

    expect(res.body.data.status).toBe('PAID');
    expect(res.body.data.invoiceUrl).toBeNull();
  });
});

describe('bundle pricing', () => {
  /** Ladder used throughout: unit 200k, Duo 350k, Trio 500k. */
  async function withLadder() {
    const made = await createTicketType({ price: 200_000, maxPerOrder: 10 });
    await prisma.eventTicketPriceTier.createMany({
      data: [
        { ticketTypeId: made.type.id, minQty: 2, totalPrice: 350_000, label: 'Duo' },
        { ticketTypeId: made.type.id, minQty: 3, totalPrice: 500_000, label: 'Trio' },
      ],
    });
    return made;
  }

  it('charges the laddered total, not price x qty', async () => {
    const { type } = await withLadder();
    const email = `ladder-${Date.now()}@test.local`;

    const result = await service().start({
      ticketTypeId: type.id,
      buyer: { name: 'Rina', email },
      attendees: [attendee(1), attendee(2), attendee(3), attendee(4)],
    });
    track((await prisma.member.findUnique({ where: { email } }))!.id);

    // Trio + 1 single. price x qty would be 800k.
    expect(result.itemTotal).toBe(700_000);
    expect(result.amount).toBe(700_000);
    expect(result.breakdown).toEqual([
      { label: 'Trio', qty: 3, amount: 500_000 },
      { label: 'Satuan', qty: 1, amount: 200_000 },
    ]);

    // And the order row carries it, which is what every report reads.
    const tx = await prisma.commerceTransaction.findUnique({
      where: { id: result.transactionId },
    });
    expect(tx!.itemTotal).toBe(700_000);
    expect(tx!.qty).toBe(4);
  });

  it('discounts a PERCENT voucher from the laddered total, not the undiscounted one', async () => {
    const { type, product } = await withLadder();
    const email = `ladder-voucher-${Date.now()}@test.local`;
    const code = `LADDER${Date.now().toString().slice(-6)}`;
    const voucher = await prisma.voucher.create({
      data: { code, type: 'PERCENT', value: 10, isActive: true },
    });
    await prisma.voucherProduct.create({
      data: { voucherId: voucher.id, productId: product.id },
    });

    const result = await service().start({
      ticketTypeId: type.id,
      buyer: { name: 'Rina', email },
      attendees: [attendee(1), attendee(2), attendee(3)],
      voucherCode: code,
    });
    track((await prisma.member.findUnique({ where: { email } }))!.id);

    // 10% of the Trio price (500k), NOT of 3 x 200k.
    expect(result.itemTotal).toBe(500_000);
    expect(result.voucherAmount).toBe(50_000);
    expect(result.amount).toBe(450_000);

    await prisma.voucherProduct.deleteMany({ where: { voucherId: voucher.id } });
    await prisma.voucher.delete({ where: { id: voucher.id } });
  });

  it('prices a kind with no ladder exactly as before', async () => {
    const { type } = await createTicketType({ price: 150_000 });
    const email = `noladder-${Date.now()}@test.local`;

    const result = await service().start({
      ticketTypeId: type.id,
      buyer: { name: 'Rina', email },
      attendees: [attendee(1), attendee(2)],
    });
    track((await prisma.member.findUnique({ where: { email } }))!.id);

    expect(result.itemTotal).toBe(300_000);
    expect(result.breakdown).toEqual([{ label: 'Satuan', qty: 2, amount: 300_000 }]);
  });

  it('exposes the ladder on the event detail payload', async () => {
    const { event, type } = await withLadder();

    const res = await request(app).get(`/api/event/${event.slug}`).expect(200);
    const kind = res.body.data.ticketTypes.find((t: { id: string }) => t.id === type.id);

    expect(kind.price).toBe(200_000);
    expect(kind.priceTiers).toEqual([
      { minQty: 2, totalPrice: 350_000, label: 'Duo' },
      { minQty: 3, totalPrice: 500_000, label: 'Trio' },
    ]);
  });

  describe('GET /api/event/quote', () => {
    it('prices a quantity without writing anything', async () => {
      const { type } = await withLadder();
      const before = await prisma.commerceTransaction.count();

      const res = await request(app)
        .get('/api/event/quote')
        .query({ ticketTypeId: type.id, qty: 5 })
        .expect(200);

      expect(res.body.data.itemTotal).toBe(850_000);
      expect(res.body.data.amount).toBe(850_000);
      expect(res.body.data.voucherAmount).toBe(0);
      expect(res.body.data.breakdown).toEqual([
        { label: 'Trio', qty: 3, amount: 500_000 },
        { label: 'Duo', qty: 2, amount: 350_000 },
      ]);
      expect(await prisma.commerceTransaction.count()).toBe(before);
    });

    it('rejects a quantity above maxPerOrder', async () => {
      const { type } = await createTicketType({ price: 200_000, maxPerOrder: 2 });
      await request(app)
        .get('/api/event/quote')
        .query({ ticketTypeId: type.id, qty: 3 })
        .expect(400);
    });

    it('404s an unknown ticket type', async () => {
      await request(app)
        .get('/api/event/quote')
        .query({ ticketTypeId: '00000000-0000-7000-8000-000000000000', qty: 1 })
        .expect(404);
    });

    it('agrees with what checkout actually charges', async () => {
      const { type } = await withLadder();
      const email = `quote-match-${Date.now()}@test.local`;

      const quoted = await request(app)
        .get('/api/event/quote')
        .query({ ticketTypeId: type.id, qty: 4 })
        .expect(200);

      const result = await service().start({
        ticketTypeId: type.id,
        buyer: { name: 'Rina', email },
        attendees: [attendee(1), attendee(2), attendee(3), attendee(4)],
      });
      track((await prisma.member.findUnique({ where: { email } }))!.id);

      // A quote the buyer is then charged differently for is worse than no quote.
      expect(result.itemTotal).toBe(quoted.body.data.itemTotal);
      expect(result.breakdown).toEqual(quoted.body.data.breakdown);
    });
  });
});

describe('event invoice redirect', () => {
  /** Same fake gateway, but it keeps what was sent so the redirect can be asserted. */
  function capturing() {
    const invoices: CreateInvoiceRequest[] = [];
    const base = mockGateway();
    const gateway: XenditGateway = {
      createInvoice: async (params) => {
        invoices.push(params);
        return base.createInvoice(params);
      },
      expireInvoice: base.expireInvoice,
    };
    return {
      svc: new EventCheckoutService(new CheckoutService(), new PaymentService(gateway)),
      invoices,
    };
  }

  async function buyOne() {
    const { type } = await createTicketType({ price: 150000 });
    const email = `redirect-${Date.now()}-${Math.floor(Math.random() * 10000)}@test.local`;
    const { svc, invoices } = capturing();
    const checkout = await svc.start({
      ticketTypeId: type.id,
      buyer: { name: 'Rina', email },
      attendees: [attendee(1)],
    });
    track((await prisma.member.findUnique({ where: { email } }))!.id);
    return { checkout, invoice: invoices[0], email };
  }

  /** The `t` value out of a redirect URL. */
  function tokenOf(url: string): string {
    return new URL(url).searchParams.get('t') ?? '';
  }

  it('points both redirects at the order page with a signed token', async () => {
    const { checkout, invoice } = await buyOne();

    // Success and failure are the SAME page: it already renders EXPIRED/CANCELED
    // and re-offers the invoice while PENDING.
    expect(invoice.successRedirectUrl).toBe(invoice.failureRedirectUrl);
    expect(invoice.successRedirectUrl).toContain(`/event/order/${checkout.transactionCode}?t=`);
    // The old generic redirect leaked the transaction UUID and carried no code.
    expect(invoice.successRedirectUrl).not.toContain('transactionId=');
    expect(tokenOf(invoice.successRedirectUrl!)).not.toBe('');
  });

  it('opens the order with only the token from that redirect', async () => {
    const { checkout, invoice } = await buyOne();

    const res = await request(app)
      .get(`/api/event/order/${checkout.transactionCode}`)
      .query({ t: tokenOf(invoice.successRedirectUrl!) })
      .expect(200);

    expect(res.body.data.transactionCode).toBe(checkout.transactionCode);
    expect(res.body.data.tickets).toHaveLength(1);
  });

  it('404s a tampered token', async () => {
    const { checkout, invoice } = await buyOne();
    const token = tokenOf(invoice.successRedirectUrl!);

    await request(app)
      .get(`/api/event/order/${checkout.transactionCode}`)
      .query({ t: `${token.slice(0, -2)}xy` })
      .expect(404);
  });

  it("404s a token minted for a different order", async () => {
    const mine = await buyOne();
    const other = await buyOne();

    await request(app)
      .get(`/api/event/order/${mine.checkout.transactionCode}`)
      .query({ t: tokenOf(other.invoice.successRedirectUrl!) })
      .expect(404);
  });

  it('follows app_settings when the order path moves', async () => {
    await prisma.appSetting.upsert({
      where: { key: SETTING_KEYS.eventOrderPath },
      create: { key: SETTING_KEYS.eventOrderPath, value: '/ticket' },
      update: { value: '/ticket' },
    });
    SettingsService.clearCache();
    try {
      const { checkout, invoice } = await buyOne();
      expect(invoice.successRedirectUrl).toContain(`/ticket/${checkout.transactionCode}?t=`);
    } finally {
      await prisma.appSetting.deleteMany({ where: { key: SETTING_KEYS.eventOrderPath } });
      SettingsService.clearCache();
    }
  });
});

describe('GET /api/event/order/:code — bearer', () => {
  const PASSWORD = 'Bearer#123';

  /** A real member with a real session, so `optionalAuthGuard` accepts the token. */
  async function member(label: string) {
    const email = `order-bearer-${label}-${Date.now()}-${Math.floor(Math.random() * 10000)}@test.local`;
    const row = await prisma.member.create({
      data: {
        email,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        fullName: 'Order Bearer',
        isEmailVerified: true,
      },
    });
    track(row.id);
    const res = await request(app)
      .post('/api/member/oauth/token')
      .send({ grant_type: 'password', username: email, password: PASSWORD });
    expect(res.status).toBe(200);
    return { id: row.id, accessToken: res.body.data.access_token as string };
  }

  it('opens the order for its own member with no query at all', async () => {
    const buyer = await member('own');
    const { type } = await createTicketType({ price: 150000 });
    const checkout = await service().start({
      ticketTypeId: type.id,
      memberId: buyer.id,
      attendees: [attendee(1)],
    });

    const res = await request(app)
      .get(`/api/event/order/${checkout.transactionCode}`)
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .expect(200);

    expect(res.body.data.transactionCode).toBe(checkout.transactionCode);
  });

  it("404s another member's order", async () => {
    const buyer = await member('owner');
    const stranger = await member('stranger');
    const { type } = await createTicketType({ price: 150000 });
    const checkout = await service().start({
      ticketTypeId: type.id,
      memberId: buyer.id,
      attendees: [attendee(1)],
    });

    await request(app)
      .get(`/api/event/order/${checkout.transactionCode}`)
      .set('Authorization', `Bearer ${stranger.accessToken}`)
      .expect(404);
  });
});
