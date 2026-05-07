import type { AppModule } from '@/core/module.interface';
import { affiliateRoutes } from './affiliate.routes';

export const AffiliateModule: AppModule = {
  name: 'affiliate',
  prefix: '/member',
  routes: affiliateRoutes,
};
