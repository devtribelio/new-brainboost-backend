import { Router } from 'express';
import { traceService } from '@bb/common/utils/trace-service';
import { bindRoute } from '@bb/common/openapi/route-binder';
import { optionalAuthGuard } from '@bb/common/middlewares/auth.middleware';
import { validateDto } from '@bb/common/middlewares/validation.middleware';
import {
  eventCheckoutEmailRateLimiter,
  eventCheckoutIpRateLimiter,
  shopVisitRateLimiter,
} from '@bb/common/middlewares/rate-limit.middleware';
import { EventCheckoutService } from '@bb/domain/event/event-checkout.service';
import { EventVisitService } from '@bb/domain/event/visit.service';
import { EventController } from './event.controller';
import { EventService } from './event.service';
import { EventCheckoutDto } from './dto/event-checkout.dto';
import { EventOrderQueryDto } from './dto/event-order.dto';

export function eventRoutes(): Router {
  const router = Router();
  const ctrl = new EventController(
    traceService(new EventService()),
    traceService(new EventCheckoutService()),
    traceService(new EventVisitService()),
  );

  // Both routes are deliberately public — an event page is marketing, reached
  // from a shortlink by people who have never opened the app. No authGuard.
  bindRoute({
    router,
    controller: ctrl,
    method: 'get',
    path: '/on-sale',
    handlerKey: 'listOnSale',
  });

  // Public and unvalidated by design: no validateDto, and the limiter lets a
  // visitor through un-counted rather than answering 429 — the same contract as
  // POST /api/shop/visits, whose limiter this reuses.
  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/visits',
    handlerKey: 'logVisit',
    middlewares: [shopVisitRateLimiter],
  });

  // Auth OPTIONAL: a guest may buy, and a logged-in buyer gets their account.
  // Two rate limiters, both must pass — this route writes a member row and
  // calls Xendit, so it is the most expensive unauthenticated endpoint we have.
  // Registered before `/:slug` for the same reason `/on-sale` is: it is a POST,
  // so it could not actually collide, but keeping the literal paths together
  // makes the ordering rule obvious to the next person adding one.
  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/checkout',
    handlerKey: 'checkout',
    middlewares: [
      eventCheckoutIpRateLimiter,
      eventCheckoutEmailRateLimiter,
      optionalAuthGuard,
      validateDto(EventCheckoutDto),
    ],
  });

  // Literal segment, so it must precede `/:slug` as well.
  bindRoute({
    router,
    controller: ctrl,
    method: 'get',
    path: '/order/:code',
    handlerKey: 'getOrder',
    middlewares: [validateDto(EventOrderQueryDto, 'query')],
  });

  // Registered AFTER /on-sale: a bare `:slug` would otherwise swallow it.
  bindRoute({
    router,
    controller: ctrl,
    method: 'get',
    path: '/:slug',
    handlerKey: 'getBySlug',
  });

  return router;
}
