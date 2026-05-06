import { Router } from 'express';
import { ReportController } from './report.controller';
import { ReportService } from './report.service';
import { authGuard } from '@/common/middlewares/auth.middleware';
import { asyncHandler } from '@/common/utils/async-handler';

export function reportRoutes(): Router {
  const router = Router();
  const ctrl = new ReportController(new ReportService());

  router.get('/report/category', asyncHandler(ctrl.categories));
  router.post('/report/memberReport', authGuard, asyncHandler(ctrl.memberReport));

  return router;
}
