import type { AppModule } from '@bb/common/core/module.interface';
import { commentRoutes } from './comment.routes';

export const CommentModule: AppModule = {
  name: 'comment',
  prefix: '/member',
  routes: commentRoutes,
};
