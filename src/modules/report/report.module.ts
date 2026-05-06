import type { AppModule } from '@/core/module.interface';
import { reportRoutes } from './report.routes';

export const ReportModule: AppModule = {
  name: 'report',
  prefix: '/member',
  routes: reportRoutes,
};
