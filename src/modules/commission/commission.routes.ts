import { Router } from 'express';
import { CommissionController } from './commission.controller';
import { CommissionService } from './commission.service';
import { authGuard } from '@/common/middlewares/auth.middleware';
import { asyncHandler } from '@/common/utils/async-handler';

export function commissionRoutes(): Router {
  const router = Router();
  const ctrl = new CommissionController(new CommissionService());

  // Ejaan path mengikuti kontrak mobile (lihat API_ENDPOINTS.md): "commisionSummary".
  router.get('/data/commisionSummary', authGuard, asyncHandler(ctrl.summary));

  return router;
}
