import type { Request, Response } from 'express';
import { ok, okCreated } from '@bb/common/utils/response.util';
import { ApiBody, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@bb/common/openapi/decorators';
import type { AuthenticatedRequest } from '@bb/common/interfaces/authenticated-request';
import { EventCheckoutService } from '@bb/domain/event/event-checkout.service';
import { EventVisitService } from '@bb/domain/event/visit.service';
import { clientIp } from '@bb/common/utils/client-ip.util';
import { EventService } from './event.service';
import { EventDetailDto, EventListResultDto } from './dto/event.dto';
import { EventCheckoutDto, EventCheckoutResultDto } from './dto/event-checkout.dto';
import { EventOrderResultDto } from './dto/event-order.dto';
import { LogEventVisitDto, EventVisitResultDto } from './dto/event-visit.dto';
import { EventQuoteResultDto } from './dto/event-quote.dto';

@ApiTags('Event')
export class EventController {
  constructor(
    private readonly eventService: EventService,
    private readonly checkoutService: EventCheckoutService,
    private readonly visitService: EventVisitService,
  ) {}

  @ApiOperation({
    summary: 'Events currently on sale (public)',
    description:
      'Feeds the shop-home swiper. Returns only events that can actually be bought into right now. An empty `items` means the swiper block is not rendered at all — there is no event index page.',
  })
  @ApiResponse({ status: 200, type: () => EventListResultDto })
  listOnSale = async (_req: Request, res: Response) => {
    const items = await this.eventService.listOnSale();
    return ok(res, { items });
  };

  @ApiOperation({
    summary: 'Price N tickets of one kind (public, read-only)',
    description:
      'The bundle ladder means the total is NOT `price x qty`, and the client must never compute it. Call this on every change of the quantity stepper and render the summary from `breakdown`. Always returns the CHEAPEST combination for that quantity. Writes nothing, reserves nothing, and applies no voucher — the discount is settled at checkout, where the member is known.',
  })
  @ApiQuery({ name: 'ticketTypeId', required: true })
  @ApiQuery({ name: 'qty', required: true, type: 'integer' })
  @ApiResponse({ status: 200, type: () => EventQuoteResultDto })
  quote = async (req: Request, res: Response) => {
    const q = req.query as unknown as { ticketTypeId: string; qty: number };
    const quoted = await this.eventService.quote(q.ticketTypeId, Number(q.qty));
    // `voucherAmount` / `amount` are echoed so the shape matches checkout, where a
    // voucher can actually apply. Here they can only be the item total.
    return ok(res, { ...quoted, voucherAmount: 0, amount: quoted.itemTotal });
  };

  @ApiOperation({
    summary: 'Event detail + ticket types (public)',
    description:
      'Serves both the event page and the checkout page. Answers 200 for a closed, canceled or finished event as well — links outlive the sale — with `canBuy: false`. A DRAFT event is 404.',
  })
  @ApiResponse({ status: 200, type: () => EventDetailDto })
  getBySlug = async (req: Request, res: Response) => {
    const detail = await this.eventService.getBySlug(String(req.params.slug ?? ''));
    return ok(res, detail);
  };

  @ApiOperation({
    summary: 'Buy event tickets (auth optional)',
    description:
      'Creates the order, holds the seats and mints the Xendit invoice in ONE call — a guest holds no token with which to make a second one. With a valid bearer the order attaches to that account and `buyer` is ignored. The response is identical whether or not the email already has an account: revealing that would make this an account-enumeration oracle.',
  })
  @ApiBody({ type: () => EventCheckoutDto })
  @ApiResponse({ status: 201, type: () => EventCheckoutResultDto })
  checkout = async (req: Request, res: Response) => {
    const dto = req.body as EventCheckoutDto;
    const user = (req as AuthenticatedRequest).user;

    const result = await this.checkoutService.start({
      ticketTypeId: dto.ticketTypeId,
      attendees: dto.attendees,
      buyer: dto.buyer,
      memberId: user?.id,
      voucherCode: dto.voucherCode,
      source: dto.source,
    });

    return okCreated(res, result);
  };

  @ApiOperation({
    summary: 'Order status by code (public, one credential required)',
    description:
      'The waiting/paid/expired page for a buyer with no account — the same link the summary email carries, and where an event invoice returns the buyer after paying. Any ONE of three credentials opens it: a bearer token for the order\'s own member, `t` (the signed token on that redirect), or the payer\'s `email`. Unknown code, wrong credential and an order holding no tickets all answer the SAME 404: a 403 would confirm to a guesser that the code exists. No credential at all is a 400 — there is nothing to check, and that answer does not depend on whether the code exists.',
  })
  @ApiQuery({ name: 'email', required: false, description: "Payer's email" })
  @ApiQuery({ name: 't', required: false, description: 'Signed token from the payment redirect' })
  @ApiResponse({ status: 200, type: () => EventOrderResultDto })
  getOrder = async (req: Request, res: Response) => {
    const query = req.query as { email?: string; t?: string };
    const order = await this.eventService.getOrderByCode(String(req.params.code ?? ''), {
      email: query.email,
      token: query.t,
      memberId: (req as AuthenticatedRequest).user?.id,
    });
    return ok(res, order);
  };

  @ApiOperation({
    summary: 'Log an event-page visit (public)',
    description:
      'Always answers 200 — a marketing link that returns 4xx loses the click it exists to measure, so bad input, an unknown slug and an exhausted rate limiter all come back as a `status` string. Stored apart from shop visits so an event\'s traffic never surfaces on the product Marketing pages.',
  })
  @ApiBody({ type: () => LogEventVisitDto })
  @ApiResponse({ status: 200, type: () => EventVisitResultDto })
  logVisit = async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

    const result = await this.visitService.logVisit({
      guestId: str(body.guestId),
      eventSlug: str(body.eventSlug),
      // The shop calls this before login; a bearer is never attached. memberId
      // is filled later by /shop/visits/claim, which binds both stores.
      memberId: null,
      utmSource: str(body.utmSource),
      utmMedium: str(body.utmMedium),
      utmCampaign: str(body.utmCampaign),
      utmContent: str(body.utmContent),
      utmTerm: str(body.utmTerm),
      // Body wins over the header: the shop is a same-origin SPA, so its own
      // Referer is the event page, not the link the visitor arrived from.
      referer: str(body.referer) ?? str(req.headers.referer),
      ipAddress: clientIp(req),
      userAgent: str(req.headers['user-agent']),
      clientEventId: str(body.clientEventId),
    });

    return ok(res, result);
  };
}
