import { Router } from 'express';
import { CommentController } from './comment.controller';
import { CommentService } from './comment.service';
import { authGuard } from '@/common/middlewares/auth.middleware';
import { asyncHandler } from '@/common/utils/async-handler';

export function commentRoutes(): Router {
  const router = Router();
  const ctrl = new CommentController(new CommentService());

  router.get('/comment/list', asyncHandler(ctrl.list));
  router.get('/comment/detail', asyncHandler(ctrl.detail));
  router.post('/comment/like', authGuard, asyncHandler(ctrl.like));
  router.post('/comment/create', authGuard, asyncHandler(ctrl.create));
  router.post('/comment/update', authGuard, asyncHandler(ctrl.update));
  router.post('/comment/delete', authGuard, asyncHandler(ctrl.remove));

  return router;
}
