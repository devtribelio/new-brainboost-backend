import { prisma } from '@bb/db';
import { notFound, ERROR_CODES } from '@bb/common/exceptions';

/** Ticket statuses that occupy a seat. See docs/event-ticketing.md K-1. */
const SEAT_TAKEN = ['RESERVED', 'ISSUED'];

export interface TicketTypeView {
  id: string;
  name: string;
  kind: string;
  price: number;
  remainingQuota: number | null;
  isSoldOut: boolean;
  maxPerOrder: number;
  saleStartsAt: Date | null;
  saleEndsAt: Date | null;
  isOnSale: boolean;
}

export interface EventListItemView {
  slug: string;
  title: string;
  coverUrl: string | null;
  startsAt: Date;
  endsAt: Date | null;
  location: string | null;
  lowestPrice: number;
  remainingQuota: number | null;
  /** Announcement strip — same two fields the detail endpoint exposes. */
  noticeText: string | null;
  noticeLinkLabel: string | null;
}

export interface EventOrderView {
  transactionCode: string;
  status: string;
  amount: number;
  paidAt: Date | null;
  expiredAt: Date | null;
  invoiceUrl: string | null;
  event: { slug: string; title: string; startsAt: Date; location: string | null };
  ticketTypeName: string;
  tickets: Array<{
    code: string;
    attendeeName: string;
    attendeeEmail: string;
    status: string;
  }>;
}

export interface EventDetailView {
  slug: string;
  title: string;
  description: string | null;
  coverUrl: string | null;
  startsAt: Date;
  endsAt: Date | null;
  location: string | null;
  locationUrl: string | null;
  status: string;
  /** Announcement strip. Plain text — never markup, so it can never become any. */
  noticeText: string | null;
  /** Clickable part of the strip; null means the strip renders as text only. */
  noticeLinkLabel: string | null;
  canBuy: boolean;
  ticketTypes: TicketTypeView[];
}

type TicketTypeRow = {
  id: string;
  name: string;
  kind: string;
  quota: number | null;
  maxPerOrder: number;
  saleStartsAt: Date | null;
  saleEndsAt: Date | null;
  product: { price: number };
};

export class EventService {
  /**
   * Events a visitor may buy into right now, for the shop-home swiper.
   *
   * "Right now" is three conditions at once: the event is ON_SALE, it has not
   * finished, and at least one of its ticket types is actually purchasable
   * (active, inside its sale window, seats left). An event failing any of them
   * keeps its page (getBySlug stays 200) but leaves the swiper — the swiper is
   * a buy prompt, and a card that leads to a page with no button is a dead end.
   */
  async listOnSale(now: Date = new Date()): Promise<EventListItemView[]> {
    const events = await prisma.event.findMany({
      where: { status: 'ON_SALE' },
      orderBy: { startsAt: 'asc' },
      select: {
        slug: true,
        title: true,
        coverUrl: true,
        startsAt: true,
        endsAt: true,
        location: true,
        // Carried here too: the strip renders on the shop home, above the
        // catalog, where only this endpoint's payload is available. Same two
        // fields as the detail endpoint — `noticeLinkUrl` stays unexposed, so a
        // client points the label at the event page it already has the slug for.
        noticeText: true,
        noticeLinkLabel: true,
        ticketTypes: {
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            name: true,
            kind: true,
            quota: true,
            maxPerOrder: true,
            saleStartsAt: true,
            saleEndsAt: true,
            product: { select: { price: true } },
          },
        },
      },
    });

    const live = events.filter((e) => !hasFinished(e.startsAt, e.endsAt, now));
    const taken = await this.seatsTaken(live.flatMap((e) => e.ticketTypes.map((t) => t.id)));

    const items: EventListItemView[] = [];
    for (const event of live) {
      const types = event.ticketTypes.map((t) => toTicketTypeView(t, taken, now));
      const sellable = types.filter((t) => t.isOnSale);
      if (sellable.length === 0) continue;

      items.push({
        slug: event.slug,
        title: event.title,
        coverUrl: event.coverUrl,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        location: event.location,
        noticeText: event.noticeText,
        noticeLinkLabel: event.noticeLinkLabel,
        lowestPrice: Math.min(...sellable.map((t) => t.price)),
        // Aggregate across every type. One unlimited type makes the whole event
        // unlimited — a partial sum would read as a seat count and be wrong.
        remainingQuota: sellable.some((t) => t.remainingQuota === null)
          ? null
          : sellable.reduce((sum, t) => sum + (t.remainingQuota ?? 0), 0),
      });
    }
    return items;
  }

  /**
   * Event page. Answers 200 for a CLOSED, CANCELED or finished event too (D-3):
   * links outlive the sale, and a 404 on one the buyer was sent yesterday reads
   * as a broken site. `canBuy` is what the page gates on.
   *
   * DRAFT is the exception — it is 404, because nobody outside the backoffice
   * may see an unpublished event.
   */
  async getBySlug(slug: string, now: Date = new Date()): Promise<EventDetailView> {
    const event = await prisma.event.findUnique({
      where: { slug },
      select: {
        slug: true,
        title: true,
        description: true,
        coverUrl: true,
        startsAt: true,
        endsAt: true,
        location: true,
        locationUrl: true,
        status: true,
        noticeText: true,
        noticeLinkLabel: true,
        // `noticeLinkUrl` is deliberately NOT selected: nothing renders it yet,
        // and an unused field in a public payload is one more thing a client can
        // start depending on before its meaning is settled.
        ticketTypes: {
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            name: true,
            kind: true,
            quota: true,
            maxPerOrder: true,
            saleStartsAt: true,
            saleEndsAt: true,
            product: { select: { price: true } },
          },
        },
      },
    });
    if (!event || event.status === 'DRAFT') throw notFound(ERROR_CODES.NOT_FOUND);

    const taken = await this.seatsTaken(event.ticketTypes.map((t) => t.id));
    const ticketTypes = event.ticketTypes.map((t) => toTicketTypeView(t, taken, now));

    return {
      slug: event.slug,
      title: event.title,
      description: event.description,
      coverUrl: event.coverUrl,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      location: event.location,
      locationUrl: event.locationUrl,
      status: event.status,
      noticeText: event.noticeText,
      noticeLinkLabel: event.noticeLinkLabel,
      // Folded into one boolean on purpose: the FE must not reassemble this
      // from `status` + dates + quota, because every client that tries gets a
      // different answer.
      canBuy:
        event.status === 'ON_SALE' &&
        !hasFinished(event.startsAt, event.endsAt, now) &&
        ticketTypes.some((t) => t.isOnSale),
      ticketTypes,
    };
  }

  /**
   * Order status for the "waiting for payment" / "paid" page.
   *
   * Public, so the payer's email stands in for a session: a guest has no
   * account to log into, and the same link is what the summary email carries.
   * Anything that fails — unknown code, wrong email, an order that holds no
   * tickets — answers the SAME 404. A 403 for "right code, wrong email" would
   * confirm to a guesser that the code exists.
   */
  async getOrderByCode(code: string, email: string): Promise<EventOrderView> {
    const order = await prisma.commerceTransaction.findUnique({
      where: { code },
      select: {
        code: true,
        status: true,
        amount: true,
        paidAt: true,
        expiredAt: true,
        member: { select: { email: true } },
        payments: {
          where: { status: 'PENDING' },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { checkoutUrl: true },
        },
        eventTickets: {
          orderBy: { createdAt: 'asc' },
          select: {
            code: true,
            attendeeName: true,
            attendeeEmail: true,
            status: true,
            ticketType: {
              select: {
                name: true,
                event: { select: { slug: true, title: true, startsAt: true, location: true } },
              },
            },
          },
        },
      },
    });

    const wanted = email.trim().toLowerCase();
    const payerEmail = order?.member.email?.trim().toLowerCase() ?? null;
    if (!order || order.eventTickets.length === 0 || !payerEmail || payerEmail !== wanted) {
      throw notFound(ERROR_CODES.NOT_FOUND);
    }

    const first = order.eventTickets[0];
    return {
      transactionCode: order.code,
      status: order.status,
      amount: order.amount,
      paidAt: order.paidAt,
      expiredAt: order.expiredAt,
      // Only while payable: a link to an invoice for a settled or dead order
      // sends the buyer to a Xendit page that can only confuse them.
      invoiceUrl: order.status === 'PENDING' ? (order.payments[0]?.checkoutUrl ?? null) : null,
      event: first.ticketType.event,
      ticketTypeName: first.ticketType.name,
      tickets: order.eventTickets.map((t) => ({
        code: t.code,
        attendeeName: t.attendeeName,
        attendeeEmail: t.attendeeEmail,
        status: t.status,
      })),
    };
  }

  /** Seats occupied per ticket type, counted from ticket rows (no counter column). */
  private async seatsTaken(ticketTypeIds: string[]): Promise<Map<string, number>> {
    if (ticketTypeIds.length === 0) return new Map();
    const rows = await prisma.eventTicket.groupBy({
      by: ['ticketTypeId'],
      where: { ticketTypeId: { in: ticketTypeIds }, status: { in: SEAT_TAKEN } },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.ticketTypeId, r._count._all]));
  }
}

/**
 * An event is over once it ends — or once it starts, when no end was given.
 * Selling during a running event is allowed (someone joining a webinar late is
 * still a sale); selling after it is over is not.
 */
function hasFinished(startsAt: Date, endsAt: Date | null, now: Date): boolean {
  return (endsAt ?? startsAt).getTime() < now.getTime();
}

function toTicketTypeView(
  t: TicketTypeRow,
  taken: Map<string, number>,
  now: Date,
): TicketTypeView {
  const remainingQuota = t.quota === null ? null : Math.max(0, t.quota - (taken.get(t.id) ?? 0));
  const isSoldOut = remainingQuota === 0;
  const windowOpen =
    (t.saleStartsAt === null || t.saleStartsAt <= now) &&
    (t.saleEndsAt === null || t.saleEndsAt > now);

  return {
    id: t.id,
    name: t.name,
    kind: t.kind,
    // Read from the product, never copied onto the ticket type: one source of
    // truth for what the buyer is charged.
    price: t.product.price,
    remainingQuota,
    isSoldOut,
    maxPerOrder: t.maxPerOrder,
    saleStartsAt: t.saleStartsAt,
    saleEndsAt: t.saleEndsAt,
    isOnSale: windowOpen && !isSoldOut,
  };
}
