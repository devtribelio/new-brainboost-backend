import type { AppModule } from '@bb/common/core/module.interface';
import { playlistRoutes } from './playlist.routes';

export const PlaylistModule: AppModule = {
  name: 'playlist',
  prefix: '/member',
  routes: playlistRoutes,
};
