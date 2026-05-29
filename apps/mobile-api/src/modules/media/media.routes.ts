import { Router } from 'express';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { optionalAuthGuard } from '@bb/common/middlewares/auth.middleware';
import { mediaDownloadRateLimiter } from '@bb/common/middlewares/rate-limit.middleware';
import { bindRoute } from '@bb/common/openapi/route-binder';

/**
 * Media proxy routes — mounted under `/api/member`.
 *
 * `optionalAuthGuard` attaches `req.user` when a valid member token is present
 * but does not reject anonymous callers: preview media must stream without a
 * login. The controller enforces auth + enrollment for non-preview media.
 *
 * Express dispatches `HEAD` requests to the registered `GET` handler, so the
 * single `bindRoute` below also covers the player's HEAD probes; the controller
 * checks `req.method` to skip the body.
 */
export function mediaRoutes(): Router {
  const router = Router();
  const ctrl = new MediaController(new MediaService());

  bindRoute({
    router,
    controller: ctrl,
    method: 'get',
    path: '/media/stream',
    handlerKey: 'stream',
    middlewares: [optionalAuthGuard],
  });

  // Download — same gating as stream, plus a per-member rate limiter to
  // discourage scripted bulk-scraping. Returns a 302 to a long-lived signed
  // Bunny MP4 URL (single-file rendition).
  bindRoute({
    router,
    controller: ctrl,
    method: 'get',
    path: '/media/download',
    handlerKey: 'download',
    middlewares: [optionalAuthGuard, mediaDownloadRateLimiter],
  });

  return router;
}
