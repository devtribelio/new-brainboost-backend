import { Router } from 'express';
import { asyncHandler } from '@bb/common/utils/async-handler';
import { adminLoginRateLimiter } from '@bb/common/middlewares/rate-limit.middleware';
import { adminAuthGuard, requireRole } from './admin.auth.middleware';
import { csrfIssue, csrfVerify } from './admin.csrf.middleware';
import { AdminAuthController } from './admin.auth.controller';
import { AdminDashboardController } from './admin.dashboard.controller';
import { createResourceRouter } from './util/crud-factory';
import { resources } from './resources';
import { adminCurationRoutes } from './admin.curation.routes';

export function adminRoutes(): Router {
  const router = Router();
  const auth = new AdminAuthController();
  const dashboard = new AdminDashboardController();

  // Seed a CSRF token for every request (incl. the pre-auth login page) so all
  // rendered forms can echo it back. Verification happens after auth below.
  router.use(csrfIssue);

  router.get('/login', auth.loginPage);
  router.post('/login', adminLoginRateLimiter, asyncHandler(auth.login));
  router.get('/logout', auth.logout);

  router.use(adminAuthGuard);

  // Enforce CSRF only on authenticated, state-changing routes — an unauthed
  // POST still falls through to the auth redirect above.
  router.use(csrfVerify);

  router.get('/', asyncHandler(dashboard.index));

  // Custom action endpoints must be registered BEFORE the generic crud loop
  // so `/posts/:id/curate` is not shadowed by the resource router on `/posts`.
  router.use('/', adminCurationRoutes());

  for (const cfg of resources) {
    // SECURITY: role-gate sensitive resources (e.g. `admins` → SUPERADMIN-only)
    // BEFORE the resource router so a low-privilege ADMIN cannot reach create/
    // edit/delete and self-escalate. adminAuthGuard above only authenticates.
    const guards = cfg.requiredRole ? [requireRole(cfg.requiredRole)] : [];
    router.use(`/${cfg.key}`, ...guards, createResourceRouter(cfg));
  }

  return router;
}
