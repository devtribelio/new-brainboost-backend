import type { AppModule } from '@/core/module.interface';
import { memberRoutes } from './member.routes';

export const MemberModule: AppModule = {
  name: 'member',
  prefix: '/member',
  routes: memberRoutes,
};
