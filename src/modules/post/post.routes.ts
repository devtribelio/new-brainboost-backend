import { Router } from 'express';
import { PostController } from './post.controller';
import { PostService } from './post.service';
import { authGuard } from '@/common/middlewares/auth.middleware';
import { asyncHandler } from '@/common/utils/async-handler';

export function postRoutes(): Router {
  const router = Router();
  const ctrl = new PostController(new PostService());

  router.get('/post/list', asyncHandler(ctrl.list));
  router.get('/post/detail', asyncHandler(ctrl.detail));
  router.post('/post/like', authGuard, asyncHandler(ctrl.like));
  // create + update share the same path (`POST /member/post/create`); diferensiasi di service.
  router.post('/post/create', authGuard, asyncHandler(ctrl.upsert));
  router.post('/post/delete', authGuard, asyncHandler(ctrl.remove));
  router.post('/post/report', authGuard, asyncHandler(ctrl.report));

  return router;
}
