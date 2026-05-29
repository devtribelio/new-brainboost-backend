import type { AppModule } from '@bb/common/core/module.interface';
import { locationRoutes } from './location.routes';

export const LocationModule: AppModule = {
  name: 'location',
  prefix: '/member',
  routes: locationRoutes,
};
