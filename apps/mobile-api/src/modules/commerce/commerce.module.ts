import type { AppModule } from '@bb/common/core/module.interface';
import { commerceRoutes } from './commerce.routes';

export const CommerceModule: AppModule = {
  name: 'commerce',
  prefix: '/member',
  routes: commerceRoutes,
};
