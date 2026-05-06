import type { AppModule } from '@/core/module.interface';
import { replyRoutes } from './reply.routes';

export const ReplyModule: AppModule = {
  name: 'reply',
  prefix: '/member',
  routes: replyRoutes,
};
