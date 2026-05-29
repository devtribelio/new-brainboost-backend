import { Router } from 'express';

/**
 * Backoffice product-ops routes. Endpoints are added per sprint — see
 * docs/backoffice-port-plan.md (auth/2fa, sales, refund, withdraw,
 * balance-adjust, affiliate-admin, moderation, dashboard, insight, search,
 * integration, feedback). Scaffold only for now.
 */
export function backofficeRoutes(): Router {
  const router = Router();
  return router;
}
