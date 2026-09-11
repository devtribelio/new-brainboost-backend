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
import { computeTicketItemTotal, type PriceLine } from './price-tier';

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
  /** Optional; stored on the ticket in full E.164. Never an identity. */
  phone?: string;
  /** Dial code for `phone`. Defaults to +62. */
  phoneCode?: string;
}

/** What actually reaches the ticket row: the phone already in E.164, or null. */
type NormalizedAttendee = { name: string; email: string; phone: string | null };

export interface EventCheckoutInput {
  ticketTypeId: string;
  attendees: EventCheckoutAttendee[];
  /**
   * Contact details typed at checkout. Every field is a FALLBACK: whatever the
   * account already holds wins, so this fills gaps and never overrides. `name` is
   * used only when a guest member has to be created.
   */
  buyer?: { name: string; email: string; phone?: string; phoneCode?: string };
  /** Logged-in buyer. When absent, a placeholder member is found or created. */
  memberId?: string;
  voucherCode?: string;
  source?: TrackingSource;
}

export interface EventCheckoutResult {
  transactionId: string;
  transactionCode: string;
  /**
   * Total for the tickets AFTER the bundle ladder — no longer `price × qty`.
   * `breakdown` says how it was reached; nothing downstream should recompute it.
   */
  itemTotal: number;
  breakdown: PriceLine[];
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
    const typedPhone = normalizeBuyerPhone(input.buyer?.phone, input.buyer?.phoneCode);
    const memberId = input.memberId ?? (await this.resolveGuestMember(input.buyer));
    // Resolved AFTER the member exists, because the account's own details win.
    const { buyerEmail, buyerPhone } = await resolveBuyerContact(memberId, {
      email: input.buyer?.email,
      phone: typedPhone,
    });
    await assertNotTrialVoucher(input.voucherCode);

    const expiryMinutes = await settingsService.getNumber(
      SETTING_KEYS.eventCheckoutExpiryMinutes,
      CHECKOUT_EXPIRY_MINUTES_DEFAULT,
    );

    // Priced here, not in CheckoutService: the ladder is event knowledge, and the
    // generic checkout must keep multiplying price × qty for everything else.
    const priced = computeTicketItemTotal(
      ticketType.product.price,
      ticketType.priceTiers,
      attendees.length,
    );

    const order = await this.checkoutService.start({
      memberId,
      productId: ticketType.productId,
      qty: attendees.length,
      itemTotal: priced.itemTotal,
      expiryMinutes,
      voucherCode: input.voucherCode,
      source: input.source,
      buyerPhone,
      buyerEmail,
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
      breakdown: priced.breakdown,
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
        product: { select: { price: true } },
        priceTiers: { select: { minQty: true, totalPrice: true, label: true } },
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
  private async resolveGuestMember(buyer?: {
    name: string;
    email: string;
    phone?: string;
    phoneCode?: string;
  }) {
    if (!buyer?.email) throw badRequest(ERROR_CODES.EVENT_ATTENDEE_INVALID);
    const email = buyer.email.trim().toLowerCase();
    if (!isEmail(email)) throw badRequest(ERROR_CODES.EVENT_ATTENDEE_INVALID);

    const existing = await prisma.member.findUnique({ where: { email }, select: { id: true } });
    // Any existing row wins, active or placeholder alike: the order belongs to
    // whoever owns that mailbox, and attaching it grants no access by itself —
    // the account still needs OTP before anyone can log into it.
    if (existing) return existing.id;

    const pair = normalizeBuyerPhone(buyer.phone, buyer.phoneCode);
    // `members.phone` is UNIQUE, and a guest may well type a number that already
    // belongs to another account. The phone is a convenience for the backoffice
    // export, never an identity here, so it is dropped rather than allowed to
    // fail a sale.
    const phoneFree = pair
      ? (await prisma.member.count({ where: { phone: pair.phone } })) === 0
      : false;

    try {
      const created = await prisma.member.create({
        data: {
          email,
          fullName: buyer.name?.trim() || email.split('@')[0],
          // The dial code travels WITH the number, never separately: `phone` holds
          // the national part alone, so a row with the number and no code reads as
          // Indonesian to `otpPhoneTarget`, which is wrong for every other country.
          ...(phoneFree && pair ? { phone: pair.phone, phoneCode: pair.phoneCode } : {}),
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
    attendees: NormalizedAttendee[],
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
      attendee: NormalizedAttendee;
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
            attendeePhone: args.attendee.phone,
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
): NormalizedAttendee[] {
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
    // An unusable number is dropped, not rejected: it is optional and nothing in
    // the sale depends on it, so failing the whole order over a typo in a field
    // the buyer did not have to fill would be the wrong trade.
    const pair = normalizeBuyerPhone(a?.phone, a?.phoneCode);
    return { name, email, phone: pair ? `${pair.phoneCode}${pair.phone}` : null };
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

/**
 * Contact details to stamp on the order: **the account's own win**, and what was
 * typed at checkout only fills what the account does not have.
 *
 * That direction is the rule, not a detail. A checkout form is not a profile
 * editor: letting a typed value beat the account's would let one event's form
 * decide where that member's receipts go, and the organiser would be handed a
 * number the member never confirmed is theirs.
 *
 * So for a member with both on file, these columns are a copy of the profile —
 * which still earns them two jobs: they are the only record when the profile
 * CANNOT take the value (a number already held by another account, a lost race),
 * and they are the snapshot of who to contact at the time of purchase, which
 * survives a later profile edit.
 *
 * Nothing here is ever written back to `members.email`. That column is the
 * account's identity (login handle, recovery channel, locked once verified) and
 * this value was merely typed into a form; an account gains an email through
 * requestVerificationEmail → validateOtpEmail, nowhere else. The phone is the
 * exception, and only into an EMPTY field — see `fillMissingMemberPhone`.
 */
async function resolveBuyerContact(
  memberId: string,
  typed: { email?: string | null; phone: PhonePair | null },
): Promise<{ buyerEmail: string | null; buyerPhone: string | null }> {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { email: true, phone: true },
  });

  const typedEmail = typeof typed.email === 'string' ? typed.email.trim().toLowerCase() : '';
  const buyerEmail = member?.email ?? (typedEmail && isEmail(typedEmail) ? typedEmail : null);

  if (member?.phone) return { buyerEmail, buyerPhone: member.phone };
  if (!typed.phone) return { buyerEmail, buyerPhone: null };

  // The profile has no number and one was typed: stamp it on the order, and fill
  // the empty profile field with it as a convenience.
  await fillMissingMemberPhone(memberId, typed.phone);
  return { buyerEmail, buyerPhone: typed.phone.phone };
}

/** National number plus its dial code. The schema keeps the two apart. */
type PhonePair = { phone: string; phoneCode: string };

/**
 * Canonical stored form, or null when nothing usable was sent.
 *
 * `phoneCode` defaults to `+62` rather than to an empty string: an empty code
 * survives `normalizeDialCode` as `''`, and `phoneCode ?? '+62'` at the read end
 * does NOT catch that, so the number would end up with no country at all.
 */
function normalizeBuyerPhone(raw?: string | null, code?: string | null): PhonePair | null {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return null;
  const dial = typeof code === 'string' && code.trim() ? code.trim() : '+62';
  const pair = normalizePhonePair(trimmed, dial);
  return pair.phone ? pair : null;
}

/**
 * Give a member a phone number ONLY if they have none.
 *
 * Never an overwrite: changing an account's contact details from a checkout form
 * is not this endpoint's business, and the number here is typed rather than
 * proven. `isPhoneVerified` therefore stays false, which is what keeps this out
 * of the phone-based account-recovery path.
 *
 * A number already held by another member is skipped rather than allowed to fail
 * the sale: `members.phone` is UNIQUE, and the order carries the number anyway.
 */
async function fillMissingMemberPhone(memberId: string, pair: PhonePair): Promise<void> {
  try {
    const taken = await prisma.member.count({ where: { phone: pair.phone } });
    if (taken > 0) return;
    // Conditional update, not read-then-write: two concurrent checkouts for the
    // same member would otherwise both see NULL and race.
    await prisma.member.updateMany({
      where: { id: memberId, phone: null },
      data: { phone: pair.phone, phoneCode: pair.phoneCode },
    });
  } catch (err) {
    // A losing race on the UNIQUE index is the expected failure here, and the
    // order already holds the number — never fail a sale over this.
    logger.warn({ err, memberId }, '[event] could not fill member phone');
  }
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
