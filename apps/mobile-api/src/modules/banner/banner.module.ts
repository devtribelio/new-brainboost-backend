import type { AppModule } from '@bb/common/core/module.interface';
import { bannerRoutes } from './banner.routes';

export const BannerModule: AppModule = {
  name: 'banner',
  prefix: '/member',
  routes: bannerRoutes,
};
