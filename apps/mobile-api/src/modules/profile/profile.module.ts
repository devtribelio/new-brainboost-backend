import type { AppModule } from '@bb/common/core/module.interface';
import { profileRoutes } from './profile.routes';

export const ProfileModule: AppModule = {
  name: 'profile',
  prefix: '/member',
  routes: profileRoutes,
};
