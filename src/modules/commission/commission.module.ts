import type { AppModule } from '@bb/common/core/module.interface';
import { commissionRoutes } from './commission.routes';

export const CommissionModule: AppModule = {
  name: 'commission',
  prefix: '/member',
  routes: commissionRoutes,
};
