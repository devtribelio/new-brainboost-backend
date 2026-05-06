import type { AppModule } from '@/core/module.interface';
import { productRoutes } from './product.routes';

export const ProductModule: AppModule = {
  name: 'product',
  prefix: '/member',
  routes: productRoutes,
};
