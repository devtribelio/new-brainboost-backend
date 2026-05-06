import type { Request, Response } from 'express';
import { ReplyService } from './reply.service';
import { notImplemented } from '@/common/utils/response.util';

export class ReplyController {
  constructor(private readonly _replyService: ReplyService) {}

  list = async (_req: Request, res: Response) => notImplemented(res, 'reply.list');
}
