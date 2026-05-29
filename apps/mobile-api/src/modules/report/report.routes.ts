import { Router } from 'express';
import { ReportController } from './report.controller';
import { ReportService } from './report.service';
import { authGuard } from '@bb/common/middlewares/auth.middleware';
import { bindRoute } from '@bb/common/openapi/route-binder';

export function reportRoutes(): Router {
  const router = Router();
  const ctrl = new ReportController(new ReportService());

  bindRoute({ router, controller: ctrl, method: 'get', path: '/report/category', handlerKey: 'categories' });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/report/memberReport', handlerKey: 'memberReport', middlewares: [authGuard] });

  return router;
}
