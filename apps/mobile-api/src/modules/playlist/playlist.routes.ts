import { traceService } from '@bb/common/utils/trace-service';
import { Router } from 'express';
import { PlaylistController } from './playlist.controller';
import { PlaylistService } from './playlist.service';
import { authGuard, optionalAuthGuard } from '@bb/common/middlewares/auth.middleware';
import { validateDto } from '@bb/common/middlewares/validation.middleware';
import {
  playlistShareMintRateLimiter,
  playlistShareReadRateLimiter,
} from '@bb/common/middlewares/rate-limit.middleware';
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

  // Share. `/playlist/shared/:token` cannot collide with `/playlist/:id` (two
  // segments vs one), so no ordering trick is needed. The read route carries
  // `optionalAuthGuard`, never `authGuard`: it must answer an anonymous caller
  // and must never 401 — the mobile interceptor attaches whatever bearer it
  // holds, expired included, and a 401 here would trigger a forced logout.
  bindRoute({ router, controller: ctrl, method: 'post', path: '/playlist/:id/share', handlerKey: 'share', middlewares: [authGuard, playlistShareMintRateLimiter] });
  bindRoute({ router, controller: ctrl, method: 'delete', path: '/playlist/:id/share', handlerKey: 'unshare', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/playlist/shared/:token/save', handlerKey: 'saveShared', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'get', path: '/playlist/shared/:token', handlerKey: 'shared', middlewares: [optionalAuthGuard, playlistShareReadRateLimiter] });

  return router;
}
