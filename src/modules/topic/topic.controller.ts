import type { Request, Response } from 'express';
import { TopicService } from './topic.service';
import { notImplemented } from '@/common/utils/response.util';

export class TopicController {
  constructor(private readonly _topicService: TopicService) {}

  list = async (_req: Request, res: Response) => notImplemented(res, 'topic.list');
  subscribe = async (_req: Request, res: Response) => notImplemented(res, 'topic.subscribe');
}
