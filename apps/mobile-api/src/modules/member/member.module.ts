import type { AppModule } from '@bb/common/core/module.interface';
import { memberRoutes } from './member.routes';

export const MemberModule: AppModule = {
  name: 'member',
  prefix: '/member',
  routes: memberRoutes,
};
