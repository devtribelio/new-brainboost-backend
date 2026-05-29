import type { AppModule } from '@bb/common/core/module.interface';
import { backofficeRoutes } from './backoffice.routes';

export const BackofficeModule: AppModule = {
  name: 'backoffice',
  prefix: '/backoffice',
  routes: () => backofficeRoutes(),
};
