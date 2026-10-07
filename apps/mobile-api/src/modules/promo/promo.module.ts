import type { AppModule } from '@bb/common/core/module.interface';
import { promoRoutes } from './promo.routes';

export const PromoModule: AppModule = {
  name: 'promo',
  prefix: '/member',
  routes: promoRoutes,
};
