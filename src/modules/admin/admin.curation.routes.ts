import { Router, type Response } from 'express';
import { asyncHandler } from '@/common/utils/async-handler';
import { PostService } from '@/modules/post/post.service';
import { CommentService } from '@/modules/comment/comment.service';
import type { AdminRequest } from './admin.types';
import { setFlash } from './util/flash';

// Coerces form-POST values ("true"/"false"/"on"/"") and JSON booleans to a
// real bool. Form checkbox sends "on" when checked, absent when not.
function parseIsCurated(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  if (raw == null) return false;
  const s = String(raw).toLowerCase();
  return s === 'true' || s === 'on' || s === '1';
}

function wantsJson(req: AdminRequest): boolean {
  const accept = req.headers.accept ?? '';
  return accept.includes('application/json');
}

export function adminCurationRoutes(): Router {
  const router = Router();
  const postService = new PostService();
  const commentService = new CommentService();

  router.post(
    '/posts/:id/curate',
    asyncHandler(async (req: AdminRequest, res: Response) => {
      const isCurated = parseIsCurated(req.body?.isCurated);
      const post = await postService.setCurated(req.params.id, isCurated);
      if (wantsJson(req)) {
        res.json({ success: true, data: { id: post.id, isCurated: post.isCurated } });
        return;
      }
      setFlash(res, 'success', `Post ${isCurated ? 'curated' : 'uncurated'}.`);
      res.redirect('/admin/posts');
    }),
  );

  router.post(
    '/comments/:id/curate',
    asyncHandler(async (req: AdminRequest, res: Response) => {
      const isCurated = parseIsCurated(req.body?.isCurated);
      const comment = await commentService.setCurated(req.params.id, isCurated);
      if (wantsJson(req)) {
        res.json({ success: true, data: { id: comment.id, isCurated: comment.isCurated } });
        return;
      }
      setFlash(res, 'success', `Comment ${isCurated ? 'curated' : 'uncurated'}.`);
      res.redirect('/admin/comments');
    }),
  );

  return router;
}
