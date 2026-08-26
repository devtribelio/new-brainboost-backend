import { traceService } from '@bb/common/utils/trace-service';
import { Router } from 'express';
import { PlaylistController } from './playlist.controller';
import { PlaylistService } from './playlist.service';
import { authGuard } from '@bb/common/middlewares/auth.middleware';
import { validateDto } from '@bb/common/middlewares/validation.middleware';
import { bindRoute } from '@bb/common/openapi/route-binder';
import { CreatePlaylistDto, PlaylistItemsDto, UpdatePlaylistDto } from './dto/create-playlist.dto';

/**
 * Playlist routes — mounted under `/api/member`.
 *
 * Reads are open to any authenticated member so a lapsed subscriber still sees
 * what they built; every write goes through `assertAccess` in the service, which
 * is the single place the subscription gate lives.
 */
export function playlistRoutes(): Router {
  const router = Router();
  const ctrl = new PlaylistController(traceService(new PlaylistService()));

  bindRoute({ router, controller: ctrl, method: 'get', path: '/playlist', handlerKey: 'list', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'get', path: '/playlist/:id', handlerKey: 'detail', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/playlist', handlerKey: 'create', middlewares: [authGuard, validateDto(CreatePlaylistDto)] });
  bindRoute({ router, controller: ctrl, method: 'patch', path: '/playlist/:id', handlerKey: 'update', middlewares: [authGuard, validateDto(UpdatePlaylistDto)] });
  bindRoute({ router, controller: ctrl, method: 'delete', path: '/playlist/:id', handlerKey: 'remove', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/playlist/:id/items', handlerKey: 'addItems', middlewares: [authGuard, validateDto(PlaylistItemsDto)] });
  bindRoute({ router, controller: ctrl, method: 'delete', path: '/playlist/:id/items', handlerKey: 'removeItems', middlewares: [authGuard, validateDto(PlaylistItemsDto)] });
  bindRoute({ router, controller: ctrl, method: 'put', path: '/playlist/:id/items/order', handlerKey: 'reorder', middlewares: [authGuard, validateDto(PlaylistItemsDto)] });

  return router;
}
