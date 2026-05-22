import type { AppModule } from '@/core/module.interface';
import { ingestRoutes } from './ingest.routes';

export const IngestModule: AppModule = {
  name: 'ingest',
  prefix: '/ingest',
  routes: ingestRoutes,
};
