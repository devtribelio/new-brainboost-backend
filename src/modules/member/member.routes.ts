import { Router } from 'express';
import { MemberController } from './member.controller';
import { MemberService } from './member.service';
import { optionalAuthGuard } from '@/common/middlewares/auth.middleware';
import { bindRoute } from '@/common/openapi/route-binder';

export function memberRoutes(): Router {
  const router = Router();
  const ctrl = new MemberController(new MemberService());

  bindRoute({ router, controller: ctrl, method: 'get', path: '/info', handlerKey: 'info', middlewares: [optionalAuthGuard] });

  return router;
}
