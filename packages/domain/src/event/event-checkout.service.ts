import { prisma } from '@bb/db';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { badRequest, notFound, ERROR_CODES } from '@bb/common/exceptions';
import { logger } from '@bb/common/config/logger';
import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import { normalizePhonePair } from '@bb/common/utils/phone.util';
import { signEventOrderToken } from '@bb/common/utils/event-order-token.util';
import { CheckoutService, type TrackingSource } from '@bb/domain/commerce/checkout.service';
import { PaymentService, type PaymentRedirect } from '@bb/domain/commerce/payment.service';
import { shopBaseUrl } from '@bb/domain/shop/shop-base-url';
import { generateTicketCode } from './ticket-code';

/** Ticket statuses that occupy a seat. See docs/event-ticketing.md K-1. */
const SEAT_TAKEN = ['RESERVED', 'ISSUED'];
/** Retries for a ticket-code unique collision (32^6 space — one is already generous). */
const CODE_RETRIES = 3;
/**
 * Minutes to pay before the seats go back on sale, when the setting is unset.
 * Far shorter than the 24h course window: a course has no quota, so an abandoned
 * checkout costs nobody anything, while an abandoned ticket checkout holds a seat
 * somebody else wanted — and an event that sells out does so in minutes.
 */
const CHECKOUT_EXPIRY_MINUTES_DEFAULT = 30;
/** Order page path on the web shop, when `app_settings['event.orderPath']` is unset. */
const ORDER_PATH_DEFAULT = '/event/order';

export interface EventCheckoutAttendee {
  name: string;
  email: string;
}

export interface EventCheckoutInput {
  ticketTypeId: string;
  attendees: EventCheckoutAttendee[];
  /** Present only for a guest checkout; ignored when `memberId` is set. */
  buyer?: { name: string; email: string; phone?: string };
  /** Logged-in buyer. When absent, a placeholder member is found or created. */
  memberId?: string;
  voucherCode?: string;
  source?: TrackingSource;
}

export interface EventCheckoutResult {
  transactionId: string;
  transactionCode: string;
  itemTotal: number;
  voucherAmount: number;
  amount: number;
  expiredAt: Date;
  payment: {
    paymentId: string;
    status: string;
    invoiceUrl: string | null;
  };
  tickets: Array<{ code: string; attendeeName: string; attendeeEmail: string }>;
}

/** Thrown inside the reservation transaction; never leaves this file. */
class SoldOutError extends Error {}

export class EventCheckoutService {
  constructor(
    private readonly checkoutService: CheckoutService = new CheckoutService(),
    private readonly paymentService: PaymentService = new PaymentService(),
  ) {}

  /**
   * Buy N tickets of one type, in one call.
   *
   * Unlike course checkout — where the client creates the order and then asks
   * for a payment in a second authenticated call — this does both. A guest
   * holds no token, so there is no second call they could make.
   *
   * Order of operations matters and is not arbitrary:
   *   1. validate + resolve the buyer  (cheap, no writes that need undoing)
   *   2. create the order              (CheckoutService — price, voucher, UTM)
   *   3. reserve the seats             (locked; rolls the order back on sold out)
   *   4. create the payment            (Xendit, or the amount=0 bypass)
   *
   * Seats are claimed AFTER the order because a ticket row needs its
   * `transaction_id`. The window between 2 and 3 cannot oversell: 3 takes a row
   * lock on the ticket type and counts inside it, so a loser sees the winner's
   * rows and aborts.
   */
  async start(input: EventCheckoutInput): Promise<EventCheckoutResult> {
    const ticketType = await this.loadSellableTicketType(input.ticketTypeId);
    const attendees = normalizeAttendees(input.attendees, ticketType.maxPerOrder);
    const memberId = input.memberId ?? (await this.resolveGuestMember(input.buyer));
    await assertNotTrialVoucher(input.voucherCode);

    const expiryMinutes = await settingsService.getNumber(
      SETTING_KEYS.eventCheckoutExpiryMinutes,
      CHECKOUT_EXPIRY_MINUTES_DEFAULT,
    );

    const order = await this.checkoutService.start({
      memberId,
      productId: ticketType.productId,
      qty: attendees.length,
      expiryMinutes,
      voucherCode: input.voucherCode,
      source: input.source,
    });

    let tickets: Array<{ code: string; attendeeName: string; attendeeEmail: string }>;
    try {
      tickets = await this.reserveSeats(ticketType.id, order.transactionId, memberId, attendees);
    } catch (err) {
      // The order exists but holds no seats — cancel it now rather than leaving
      // it for the sweeper, so the buyer's next attempt is not shadowed by a
      // stale PENDING order of theirs.
      await this.releaseOrder(order.transactionId);
      if (err instanceof SoldOutError) throw badRequest(ERROR_CODES.EVENT_TICKET_SOLD_OUT);
      throw err;
    }

    const payment = await this.paymentService.create(
      memberId,
      { transactionId: order.transactionId },
      { redirect: await this.orderPageRedirect(order.transactionCode) },
    );

    return {
      transactionId: order.transactionId,
      transactionCode: order.transactionCode,
      itemTotal: order.itemTotal,
      voucherAmount: order.voucherAmount,
      amount: order.amount,
      expiredAt: order.expiredAt,
      payment: {
        paymentId: payment.paymentId,
        status: payment.paymentStatus,
        invoiceUrl: payment.invoiceUrl ?? null,
      },
      tickets,
    };
  }

  /**
   * Where Xendit returns the buyer — the order page, carrying a signed token.
   *
   * Success and failure point at the SAME page: it already renders EXPIRED and
   * CANCELED and re-offers `invoiceUrl` while the order is still PENDING, so a
   * dedicated failure page would only duplicate it.
   *
   * The token stands in for the payer's email, which that page normally
   * authenticates on and which a redirect cannot carry — the buyer who opened
   * checkout on a desktop and paid by QR on a phone arrives with nothing to read
   * it back out of.
   */
  private async orderPageRedirect(transactionCode: string): Promise<PaymentRedirect> {
    const [base, path] = await Promise.all([
      shopBaseUrl(),
      settingsService.get(SETTING_KEYS.eventOrderPath, ORDER_PATH_DEFAULT),
    ]);
    const clean = `/${path.trim().replace(/^\/+|\/+$/g, '')}`;
    const token = signEventOrderToken(transactionCode);
    const url = `${base}${clean}/${encodeURIComponent(transactionCode)}?t=${token}`;
    return { successUrl: url, failureUrl: url };
  }

  /**
   * The ticket type must exist, be active, sit inside its sale window, and
   * belong to an event that is ON_SALE and not yet over. All four collapse to
   * one error code: telling a buyer *which* of them failed helps nobody, and
   * the event page already renders the reason.
   */
  private async loadSellableTicketType(ticketTypeId: string) {
    const type = await prisma.eventTicketType.findUnique({
      where: { id: ticketTypeId },
      select: {
        id: true,
        productId: true,
        quota: true,
        maxPerOrder: true,
        isActive: true,
        saleStartsAt: true,
        saleEndsAt: true,
        event: { select: { status: true, startsAt: true, endsAt: true } },
      },
    });
    if (!type) throw notFound(ERROR_CODES.NOT_FOUND);

    const now = new Date();
    const finished = (type.event.endsAt ?? type.event.startsAt).getTime() < now.getTime();
    const windowOpen =
      (type.saleStartsAt === null || type.saleStartsAt <= now) &&
      (type.saleEndsAt === null || type.saleEndsAt > now);

    if (!type.isActive || !windowOpen || finished || type.event.status !== 'ON_SALE') {
      throw badRequest(ERROR_CODES.EVENT_NOT_ON_SALE);
    }
    return type;
  }

  /**
   * Guest checkout: the order still hangs off a real member row, because every
   * `commerce.payment.success` listener assumes one. The buyer is never logged
   * in and never told whether the email already had an account — that answer is
   * exactly what an enumeration probe is after.
   */
  private async resolveGuestMember(buyer?: { name: string; email: string; phone?: string }) {
    if (!buyer?.email) throw badRequest(ERROR_CODES.EVENT_ATTENDEE_INVALID);
    const email = buyer.email.trim().toLowerCase();
    if (!isEmail(email)) throw badRequest(ERROR_CODES.EVENT_ATTENDEE_INVALID);

    const existing = await prisma.member.findUnique({ where: { email }, select: { id: true } });
    // Any existing row wins, active or placeholder alike: the order belongs to
    // whoever owns that mailbox, and attaching it grants no access by itself —
    // the account still needs OTP before anyone can log into it.
    if (existing) return existing.id;

    const phone = buyer.phone ? normalizePhonePair(buyer.phone, '+62').phone : null;
    // `members.phone` is UNIQUE, and a guest may well type a number that already
    // belongs to another account. The phone is a convenience for the backoffice
    // export, never an identity here, so it is dropped rather than allowed to
    // fail a sale.
    const phoneFree = phone
      ? (await prisma.member.count({ where: { phone } })) === 0
      : false;

    try {
      const created = await prisma.member.create({
        data: {
          email,
          fullName: buyer.name?.trim() || email.split('@')[0],
          ...(phoneFree && phone ? { phone } : {}),
          // Same sentinel the social-signup path writes: unusable as a password,
          // and `passwordAlgo: 'social'` keeps `verifyPassword` from ever
          // treating it as an md5 hash.
          passwordHash: `${randomUUID()}${randomUUID()}`,
          passwordAlgo: 'social',
          isActive: false,
          isEmailVerified: false,
        },
        select: { id: true },
      });
      return created.id;
    } catch (err) {
      // Race: a concurrent checkout (or a register) created the same email first.
      if (isUniqueViolation(err)) {
        const retry = await prisma.member.findUnique({ where: { email }, select: { id: true } });
        if (retry) return retry.id;
      }
      throw err;
    }
  }

  /**
   * Claim `attendees.length` seats and write the tickets, atomically.
   *
   * `SELECT … FOR UPDATE` on the ticket type row is what serialises two buyers
   * racing for the last seat: the loser blocks until the winner commits, then
   * counts and sees the winner's tickets. Counting rows rather than keeping a
   * counter column means a released seat needs no decrement to be correct — the
   * count is the truth, always.
   */
  private async reserveSeats(
    ticketTypeId: string,
    transactionId: string,
    buyerMemberId: string,
    attendees: EventCheckoutAttendee[],
  ) {
    return prisma.$transaction(async (txdb) => {
      const locked = await txdb.$queryRaw<Array<{ quota: number | null }>>`
        SELECT quota FROM event_ticket_types WHERE id = ${ticketTypeId}::uuid FOR UPDATE
      `;
      const quota = locked[0]?.quota ?? null;

      if (quota !== null) {
        const taken = await txdb.eventTicket.count({
          where: { ticketTypeId, status: { in: SEAT_TAKEN } },
        });
        if (taken + attendees.length > quota) throw new SoldOutError();
      }

      const created: Array<{ code: string; attendeeName: string; attendeeEmail: string }> = [];
      for (const attendee of attendees) {
        created.push(
          await this.insertTicket(txdb, {
            ticketTypeId,
            transactionId,
            buyerMemberId,
            attendee,
          }),
        );
      }
      return created;
    });
  }

  /** Insert one ticket, retrying only on a code collision. */
  private async insertTicket(
    txdb: Prisma.TransactionClient,
    args: {
      ticketTypeId: string;
      transactionId: string;
      buyerMemberId: string;
      attendee: EventCheckoutAttendee;
    },
  ) {
    for (let attempt = 0; ; attempt++) {
      const code = generateTicketCode();
      try {
        await txdb.eventTicket.create({
          data: {
            code,
            ticketTypeId: args.ticketTypeId,
            transactionId: args.transactionId,
            buyerMemberId: args.buyerMemberId,
            attendeeName: args.attendee.name,
            attendeeEmail: args.attendee.email,
            status: 'RESERVED',
          },
          select: { id: true },
        });
        return {
          code,
          attendeeName: args.attendee.name,
          attendeeEmail: args.attendee.email,
        };
      } catch (err) {
        if (attempt < CODE_RETRIES && isUniqueViolation(err)) {
          logger.warn({ code }, '[event] ticket code collision, retrying');
          continue;
        }
        throw err;
      }
    }
  }

  /** Cancel an order that never got its seats. Best-effort: it expires anyway. */
  private async releaseOrder(transactionId: string): Promise<void> {
    await prisma.commerceTransaction
      .updateMany({
        where: { id: transactionId, status: 'PENDING' },
        data: { status: 'CANCELED', canceledAt: new Date() },
      })
      .catch((err) => logger.error({ err, transactionId }, '[event] failed to release order'));
  }
}

/**
 * One order buys between 1 and `maxPerOrder` tickets. Duplicate emails are
 * legal and deliberate (P5) — one person may buy for a group and receive every
 * code themselves.
 */
function normalizeAttendees(
  attendees: EventCheckoutAttendee[] | undefined,
  maxPerOrder: number,
): EventCheckoutAttendee[] {
  if (!Array.isArray(attendees) || attendees.length === 0) {
    throw badRequest(ERROR_CODES.EVENT_TICKET_QTY_INVALID);
  }
  if (attendees.length > maxPerOrder) {
    throw badRequest(ERROR_CODES.EVENT_TICKET_QTY_INVALID, { maxPerOrder });
  }
  return attendees.map((a) => {
    const name = typeof a?.name === 'string' ? a.name.trim() : '';
    const email = typeof a?.email === 'string' ? a.email.trim().toLowerCase() : '';
    if (!name || !isEmail(email)) throw badRequest(ERROR_CODES.EVENT_ATTENDEE_INVALID);
    return { name, email };
  });
}

/**
 * A TRIAL voucher grants time-boxed COURSE access; it means nothing for a
 * ticket. Left alone it would still discount 100% (computeTotals treats TRIAL
 * as full price off) and hand out a free seat with no trial recorded anywhere —
 * a quota leak dressed as a promo. Whitelisting discipline should prevent it;
 * this makes it impossible.
 */
async function assertNotTrialVoucher(code?: string): Promise<void> {
  if (!code) return;
  const voucher = await prisma.voucher.findUnique({
    where: { code },
    select: { type: true },
  });
  if (voucher?.type === 'TRIAL') throw badRequest(ERROR_CODES.VOUCHER_INVALID);
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
