import type { Request, Response } from 'express';
import { CommentService } from './comment.service';
import { notImplemented } from '@/common/utils/response.util';

export class CommentController {
  constructor(private readonly _commentService: CommentService) {}

  list = async (_req: Request, res: Response) => notImplemented(res, 'comment.list');
  detail = async (_req: Request, res: Response) => notImplemented(res, 'comment.detail');
  like = async (_req: Request, res: Response) => notImplemented(res, 'comment.like');
  create = async (_req: Request, res: Response) => notImplemented(res, 'comment.create');
  update = async (_req: Request, res: Response) => notImplemented(res, 'comment.update');
  remove = async (_req: Request, res: Response) => notImplemented(res, 'comment.remove');
}
