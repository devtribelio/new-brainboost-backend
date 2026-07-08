import { Router } from 'express';
import { authGuard } from '@bb/common/middlewares/auth.middleware';
import { validateDto } from '@bb/common/middlewares/validation.middleware';
import { bindRoute } from '@bb/common/openapi/route-binder';
import { SubscriptionService } from '@bb/domain/subscription/subscription.service';
import { SeatService } from '@bb/domain/subscription/seat.service';
import { EntitlementService } from '@bb/domain/subscription/entitlement.service';
import { SubscriptionController } from './subscription.controller';
import { ClaimSeatDto } from './dto/subscription.dto';

export function subscriptionRoutes(): Router {
  const router = Router();
  const ctrl = new SubscriptionController(
    new SubscriptionService(),
    new SeatService(),
    new EntitlementService(),
  );

  // Public: the paywall reads plans without a session.
  bindRoute({ router, controller: ctrl, method: 'get', path: '/plans', handlerKey: 'plans' });

  bindRoute({ router, controller: ctrl, method: 'get', path: '/me', handlerKey: 'me', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/seats/invite', handlerKey: 'invite', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/seats/claim', handlerKey: 'claim', middlewares: [authGuard, validateDto(ClaimSeatDto)] });
  bindRoute({ router, controller: ctrl, method: 'delete', path: '/seats/:seatId', handlerKey: 'removeSeat', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/seats/leave', handlerKey: 'leaveSeat', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/cancel', handlerKey: 'cancel', middlewares: [authGuard] });

  return router;
}
