import type { AppModule } from '@/core/module.interface';
import { locationRoutes } from './location.routes';

export const LocationModule: AppModule = {
  name: 'location',
  prefix: '/member',
  routes: locationRoutes,
};
