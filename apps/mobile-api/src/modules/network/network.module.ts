import type { AppModule } from '@bb/common/core/module.interface';
import { networkRoutes } from './network.routes';

export const NetworkModule: AppModule = {
  name: 'network',
  prefix: '/member',
  routes: networkRoutes,
};
