import { Router } from 'express';
import { asyncHandler } from '@/common/utils/async-handler';
import { adminAuthGuard } from './admin.auth.middleware';
import { AdminAuthController } from './admin.auth.controller';
import { AdminDashboardController } from './admin.dashboard.controller';
import { createResourceRouter } from './util/crud-factory';
import { resources } from './resources';

export function adminRoutes(): Router {
  const router = Router();
  const auth = new AdminAuthController();
  const dashboard = new AdminDashboardController();

  router.get('/login', auth.loginPage);
  router.post('/login', asyncHandler(auth.login));
  router.get('/logout', auth.logout);

  router.use(adminAuthGuard);

  router.get('/', asyncHandler(dashboard.index));

  for (const cfg of resources) {
    router.use(`/${cfg.key}`, createResourceRouter(cfg));
  }

  return router;
}
