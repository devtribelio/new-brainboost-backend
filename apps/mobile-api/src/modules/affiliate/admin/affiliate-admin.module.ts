import type { AppModule } from '@bb/common/core/module.interface';
import { affiliateAdminRoutes } from './affiliate-admin.routes';

/**
 * Staff JSON endpoints for affiliate payout + KYC review. Mounted under `/api/admin`.
 * Auth: admin JWT (Authorization: Bearer) — see admin-bearer.guard.ts.
 */
export const AffiliateAdminModule: AppModule = {
  name: 'affiliate-admin',
  prefix: '/admin',
  routes: affiliateAdminRoutes,
};
