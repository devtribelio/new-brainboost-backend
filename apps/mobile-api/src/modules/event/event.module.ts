import type { AppModule } from '@bb/common/core/module.interface';
import { eventRoutes } from './event.routes';

export const EventModule: AppModule = {
  name: 'event',
  prefix: '/event',
  routes: eventRoutes,
};
