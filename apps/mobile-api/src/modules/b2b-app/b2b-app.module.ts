import type { AppModule } from '@bb/common/core/module.interface';
import { b2bAppRoutes } from './b2b-app.routes';

/** Company (B2B) app endpoints: /api/b2b-app/*. Contract: docs/b2b-app-contract.md. */
export const B2bAppModule: AppModule = {
  name: 'b2b-app',
  prefix: '/b2b-app',
  routes: b2bAppRoutes,
};
