import type { Request, Response } from 'express';
import { TopicService } from './topic.service';
import { ok } from '@/common/utils/response.util';
import { BadRequestException, UnauthorizedException } from '@/common/exceptions';
import { buildPageMeta, parsePagination } from '@/common/utils/pagination.util';
import { serializeTopic } from '@/common/serializers';
import type { AuthenticatedRequest } from '@/common/interfaces/authenticated-request';

export class TopicController {
  constructor(private readonly topicService: TopicService) {}

  list = async (req: Request, res: Response) => {
    const p = parsePagination(req.query as Record<string, unknown>);
    const keyword = (req.query.keyword as string) ?? undefined;
    const networkId = (req.query.networkId as string) ?? undefined;
    const { rows, total } = await this.topicService.list(p, { keyword, networkId });
    return ok(res, rows.map(serializeTopic), buildPageMeta(total, p));
  };

  subscribe = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const topicId = (req.body?.topicId as string) ?? '';
    if (!topicId) throw new BadRequestException('topicId required');
    const action = (req.body?.action as string) ?? 'subscribe';
    if (action === 'unsubscribe') {
      await this.topicService.unsubscribe(req.user.id, topicId);
    } else {
      await this.topicService.subscribe(req.user.id, topicId);
    }
    return ok(res, { topicId, action });
  };
}
