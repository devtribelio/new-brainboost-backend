import type { AppModule } from '@/core/module.interface';
import { topicRoutes } from './topic.routes';

export const TopicModule: AppModule = {
  name: 'topic',
  prefix: '/member',
  routes: topicRoutes,
};
