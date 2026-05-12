import type { Request, Response } from 'express';
import { TopicService } from './topic.service';
import { ok } from '@/common/utils/response.util';
import { BadRequestException, UnauthorizedException } from '@/common/exceptions';
import { buildLegacyPage, parsePagination } from '@/common/utils/pagination.util';
import { serializeTopic } from '@/common/serializers';
import type { AuthenticatedRequest } from '@/common/interfaces/authenticated-request';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@/common/openapi/decorators';
import { TopicPageDto, TopicSubscribeResultDto } from './dto/topic.dto';

@ApiTags('Topic')
export class TopicController {
  constructor(private readonly topicService: TopicService) {}

  @ApiOperation({ summary: 'List topics' })
  @ApiQuery({ name: 'page', type: 'integer', required: false, example: 1 })
  @ApiQuery({ name: 'perPage', type: 'integer', required: false, example: 20 })
  @ApiQuery({ name: 'keyword', type: 'string', required: false, example: 'tech' })
  @ApiQuery({
    name: 'code',
    type: 'string',
    required: false,
    example: 'BB-TIMELINE',
    description: 'Network code (FE primary). Falls back to legacyId int / UUID.',
  })
  @ApiQuery({ name: 'networkId', type: 'string', required: false, example: 'network-uuid-1234' })
  @ApiResponse({ status: 200, type: () => TopicPageDto })
  list = async (req: Request, res: Response) => {
    const p = parsePagination(req.query as Record<string, unknown>);
    const keyword = (req.query.keyword as string) ?? undefined;
    // FE sends `code` (network code). `networkId` accepted as alias for backwards compat.
    const networkInput =
      (req.query.code as string) ?? (req.query.networkId as string) ?? undefined;
    const { rows, total } = await this.topicService.list(p, { keyword, networkInput });
    return ok(res, buildLegacyPage(rows.map(serializeTopic), total, p));
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Subscribe / unsubscribe to a topic' })
  @ApiResponse({ status: 200, type: () => TopicSubscribeResultDto })
  subscribe = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const topicId = (req.body?.topicId as string) ?? '';
    if (!topicId) throw new BadRequestException('topicId required');
    const action = (req.body?.action as string) ?? 'subscribe';
    const result =
      action === 'unsubscribe'
        ? await this.topicService.unsubscribe(req.user.id, topicId)
        : await this.topicService.subscribe(req.user.id, topicId);
    // FE SubscribeModel: {memberId, topicId, isSubscribeTopic}. Status + action
    // kept as extras (FE parser tolerates unknown keys).
    return ok(res, {
      memberId: result.memberLegacyId,
      topicId: result.topicLegacyId,
      isSubscribeTopic: result.isSubscribeTopic,
      status: result.status,
      action,
    });
  };
}
