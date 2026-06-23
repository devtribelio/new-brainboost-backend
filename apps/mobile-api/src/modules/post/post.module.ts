import type { AppModule } from '@bb/common/core/module.interface';
import { postRoutes } from './post.routes';

export const PostModule: AppModule = {
  name: 'post',
  prefix: '/member',
  routes: postRoutes,
};
