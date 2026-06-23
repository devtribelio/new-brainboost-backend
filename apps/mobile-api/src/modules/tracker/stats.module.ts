import type { AppModule } from '@bb/common/core/module.interface';
import { statsRoutes } from './stats.routes';

/** GET /api/user/stats/home — derived home-screen metrics (spec §5.2). */
export const StatsModule: AppModule = {
  name: 'stats',
  prefix: '/user',
  routes: statsRoutes,
};
