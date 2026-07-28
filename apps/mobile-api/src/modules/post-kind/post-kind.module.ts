import type { AppModule } from '@bb/common/core/module.interface';
import { postKindRoutes } from './post-kind.routes';

// Prefix `/community` (not `/member`) so the effective path is
// `/api/community/post-kinds`, matching the FE contract §4.
export const PostKindModule: AppModule = {
  name: 'post-kind',
  prefix: '/community',
  routes: postKindRoutes,
};
