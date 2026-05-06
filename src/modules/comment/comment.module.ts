import type { AppModule } from '@/core/module.interface';
import { commentRoutes } from './comment.routes';

export const CommentModule: AppModule = {
  name: 'comment',
  prefix: '/member',
  routes: commentRoutes,
};
