import { Router } from 'express';
import { asyncHandler } from '@/common/utils/async-handler';
import { adminLoginRateLimiter } from '@/common/middlewares/rate-limit.middleware';
import { adminAuthGuard } from './admin.auth.middleware';
import { AdminAuthController } from './admin.auth.controller';
import { AdminDashboardController } from './admin.dashboard.controller';
import { createResourceRouter } from './util/crud-factory';
import { resources } from './resources';
import { adminCurationRoutes } from './admin.curation.routes';

export function adminRoutes(): Router {
  const router = Router();
  const auth = new AdminAuthController();
  const dashboard = new AdminDashboardController();

  router.get('/login', auth.loginPage);
  router.post('/login', adminLoginRateLimiter, asyncHandler(auth.login));
  router.get('/logout', auth.logout);

  router.use(adminAuthGuard);

  router.get('/', asyncHandler(dashboard.index));

  // Custom action endpoints must be registered BEFORE the generic crud loop
  // so `/posts/:id/curate` is not shadowed by the resource router on `/posts`.
  router.use('/', adminCurationRoutes());

  for (const cfg of resources) {
    router.use(`/${cfg.key}`, createResourceRouter(cfg));
  }

  return router;
}
