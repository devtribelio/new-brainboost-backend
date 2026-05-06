import type { AppModule } from '@/core/module.interface';
import { accountRoutes } from './account.routes';

export const AccountModule: AppModule = {
  name: 'account',
  prefix: '/member',
  routes: accountRoutes,
};
