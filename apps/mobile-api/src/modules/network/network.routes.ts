import { Router } from 'express';
import { NetworkController } from './network.controller';
import { NetworkService } from './network.service';
import { authGuard } from '@bb/common/middlewares/auth.middleware';
import { bindRoute } from '@bb/common/openapi/route-binder';

export function networkRoutes(): Router {
  const router = Router();
  const ctrl = new NetworkController(new NetworkService());

  bindRoute({ router, controller: ctrl, method: 'post', path: '/network/join', handlerKey: 'join', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/network/request/approve', handlerKey: 'approveRequest', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/network/request/reject', handlerKey: 'rejectRequest', middlewares: [authGuard] });
  // SECURITY: must be authenticated. Without authGuard this endpoint leaked
  // every member's PII (email/phone/birthdate/address) to anonymous callers,
  // and the empty-input "lists-all" parity (CLAUDE.md §5) made it a full member
  // dump. Legacy gated this behind auth; restore that. PII-field minimisation in
  // serializeNetworkMemberLegacy is tracked separately (needs FE coordination).
  bindRoute({ router, controller: ctrl, method: 'get', path: '/network/member', handlerKey: 'members', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'get', path: '/network/tag', handlerKey: 'tags', middlewares: [authGuard] });

  return router;
}
