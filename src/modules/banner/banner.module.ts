import type { AppModule } from '@/core/module.interface';
import { bannerRoutes } from './banner.routes';

export const BannerModule: AppModule = {
  name: 'banner',
  prefix: '/member',
  routes: bannerRoutes,
};
