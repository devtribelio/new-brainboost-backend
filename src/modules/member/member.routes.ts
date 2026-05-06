import { Router } from 'express';
import { MemberController } from './member.controller';
import { MemberService } from './member.service';
import { authGuard } from '@/common/middlewares/auth.middleware';
import { asyncHandler } from '@/common/utils/async-handler';

export function memberRoutes(): Router {
  const router = Router();
  const ctrl = new MemberController(new MemberService());

  router.get('/info', authGuard, asyncHandler(ctrl.info));

  return router;
}
