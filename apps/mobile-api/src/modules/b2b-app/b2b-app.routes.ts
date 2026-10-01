import { Router } from 'express';
import { authGuard } from '@bb/common/middlewares/auth.middleware';
import { bindRoute } from '@bb/common/openapi/route-binder';
import { B2bAppController } from './b2b-app.controller';
import { B2bAppService } from './b2b-app.service';

export function b2bAppRoutes(): Router {
  const router = Router();
  const ctrl = new B2bAppController(new B2bAppService());

  bindRoute({ router, controller: ctrl, method: 'get', path: '/companies', handlerKey: 'listCompanies', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'get', path: '/companies/:companyId', handlerKey: 'getCompany', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'get', path: '/companies/:companyId/courses', handlerKey: 'listCourses', middlewares: [authGuard] });

  return router;
}
