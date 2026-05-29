import type { AppModule } from '@bb/common/core/module.interface';
import { replyRoutes } from './reply.routes';

export const ReplyModule: AppModule = {
  name: 'reply',
  prefix: '/member',
  routes: replyRoutes,
};
