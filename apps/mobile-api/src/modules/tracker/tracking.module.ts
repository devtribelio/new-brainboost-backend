import type { AppModule } from '@bb/common/core/module.interface';
import { trackingRoutes } from './tracking.routes';

/** POST /api/tracking/session — listening-session ingest (spec §5.1). */
export const TrackingModule: AppModule = {
  name: 'tracking',
  prefix: '/tracking',
  routes: trackingRoutes,
};
