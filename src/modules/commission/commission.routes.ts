import { Router } from 'express';
import { CommissionController } from './commission.controller';
import { CommissionService } from './commission.service';
import { authGuard } from '@/common/middlewares/auth.middleware';
import { bindRoute } from '@/common/openapi/route-binder';

export function commissionRoutes(): Router {
  const router = Router();
  const ctrl = new CommissionController(new CommissionService());

  // Path spelling matches mobile contract (API_ENDPOINTS.md): "commisionSummary".
  bindRoute({ router, controller: ctrl, method: 'get', path: '/data/commisionSummary', handlerKey: 'summary', middlewares: [authGuard] });

  return router;
}
