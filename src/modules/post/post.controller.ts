import type { Request, Response } from 'express';
import { PostService } from './post.service';
import { notImplemented } from '@/common/utils/response.util';

export class PostController {
  constructor(private readonly _postService: PostService) {}

  list = async (_req: Request, res: Response) => notImplemented(res, 'post.list');
  detail = async (_req: Request, res: Response) => notImplemented(res, 'post.detail');
  like = async (_req: Request, res: Response) => notImplemented(res, 'post.like');
  upsert = async (_req: Request, res: Response) => notImplemented(res, 'post.upsert');
  remove = async (_req: Request, res: Response) => notImplemented(res, 'post.remove');
  report = async (_req: Request, res: Response) => notImplemented(res, 'post.report');
}
