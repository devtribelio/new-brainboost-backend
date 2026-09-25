import type { AppModule } from '@bb/common/core/module.interface';
import { shopRoutes } from './shop.routes';

export const ShopModule: AppModule = {
  name: 'shop',
  prefix: '/shop',
  routes: shopRoutes,
};
