import type { AppModule } from '@bb/common/core/module.interface';
import { topicRoutes } from './topic.routes';

export const TopicModule: AppModule = {
  name: 'topic',
  prefix: '/member',
  routes: topicRoutes,
};
