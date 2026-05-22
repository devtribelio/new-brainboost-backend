import type { AppModule } from '@/core/module.interface';
import { mediaRoutes } from './media.routes';

export const MediaModule: AppModule = {
  name: 'media',
  prefix: '/member',
  routes: mediaRoutes,
};
