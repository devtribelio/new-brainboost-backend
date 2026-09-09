import type { Request, Response } from 'express';
import { ok, okCreated } from '@bb/common/utils/response.util';
import { ApiBody, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@bb/common/openapi/decorators';
import type { AuthenticatedRequest } from '@bb/common/interfaces/authenticated-request';
import { EventCheckoutService } from '@bb/domain/event/event-checkout.service';
import { EventService } from './event.service';
import { EventDetailDto, EventListResultDto } from './dto/event.dto';
import { EventCheckoutDto, EventCheckoutResultDto } from './dto/event-checkout.dto';
import { EventOrderResultDto } from './dto/event-order.dto';

@ApiTags('Event')
export class EventController {
  constructor(
    private readonly eventService: EventService,
    private readonly checkoutService: EventCheckoutService,
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
    summary: 'Order status by code (public, payer email required)',
    description:
      'The waiting/paid/expired page for a buyer with no account — the same link the summary email carries. Unknown code, wrong email and an order holding no tickets all answer the SAME 404: a 403 would confirm to a guesser that the code exists.',
  })
  @ApiQuery({ name: 'email', required: true, description: "Payer's email" })
  @ApiResponse({ status: 200, type: () => EventOrderResultDto })
  getOrder = async (req: Request, res: Response) => {
    const order = await this.eventService.getOrderByCode(
      String(req.params.code ?? ''),
      String((req.query as { email?: string }).email ?? ''),
    );
    return ok(res, order);
  };
}
