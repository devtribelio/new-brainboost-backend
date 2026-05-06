import type { AppModule } from '@/core/module.interface';
import { authRoutes } from './auth.routes';

export const AuthModule: AppModule = {
  name: 'auth',
  prefix: '/member',
  routes: authRoutes,
};
