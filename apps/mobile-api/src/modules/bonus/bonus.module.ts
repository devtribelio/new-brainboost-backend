import type { AppModule } from '@bb/common/core/module.interface';
import { bonusRoutes } from './bonus.routes';

export const BonusModule: AppModule = {
  name: 'bonus',
  prefix: '/member',
  routes: bonusRoutes,
};
