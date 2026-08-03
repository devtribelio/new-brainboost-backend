import type { AppModule } from '@bb/common/core/module.interface';
import { appVersionRoutes } from './app-version.routes';

export const AppVersionModule: AppModule = {
  name: 'app-version',
  prefix: '/app',
  routes: appVersionRoutes,
};
