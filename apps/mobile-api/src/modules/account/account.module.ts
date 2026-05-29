import type { AppModule } from '@bb/common/core/module.interface';
import { accountRoutes } from './account.routes';

export const AccountModule: AppModule = {
  name: 'account',
  prefix: '/member',
  routes: accountRoutes,
};
