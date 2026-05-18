import type { Request, Response } from 'express';
import { NetworkService } from './network.service';
import { ok } from '@/common/utils/response.util';
import { BadRequestException, UnauthorizedException } from '@/common/exceptions';
import { buildLegacyPage, parsePagination } from '@/common/utils/pagination.util';
import { serializeNetworkMemberLegacy } from './network.serializer';
import type { AuthenticatedRequest } from '@/common/interfaces/authenticated-request';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@/common/openapi/decorators';
import {
  NetworkJoinResultDto,
  NetworkMemberPageDto,
  NetworkTagPageDto,
} from './dto/network.dto';
import { NetworkJoinBodyDto } from './dto/network-join-body.dto';

@ApiTags('Network')
export class NetworkController {
  constructor(private readonly networkService: NetworkService) {}

  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Join / leave a network',
    description:
      'Body must include one of `code`, `networkCode`, or `networkId`. Set `action` to `leave` to remove membership; otherwise defaults to join.',
  })
  @ApiBody({ type: () => NetworkJoinBodyDto })
  @ApiResponse({ status: 200, type: () => NetworkJoinResultDto })
  join = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    // Mobile sends `code`, legacy stub used `networkId` — accept both
    const networkInput =
      (req.body?.code as string) ||
      (req.body?.networkCode as string) ||
      (req.body?.networkId as string) ||
      '';
    if (!networkInput) throw new BadRequestException('code or networkId required');
    const action = (req.body?.action as string) ?? 'join';
    if (action === 'leave') {
      return ok(res, await this.networkService.leave(req.user.id, networkInput));
    }
    return ok(res, await this.networkService.join(req.user.id, networkInput));
  };

  @ApiOperation({
    summary: 'List members of a network (or all networks if no code/networkId provided)',
  })
  @ApiQuery({ name: 'code', type: 'string', required: false, example: 'timeline-main' })
  @ApiQuery({
    name: 'networkId',
    type: 'string',
    required: false,
    example: 'network-uuid-1234',
  })
  @ApiQuery({ name: 'page', type: 'integer', required: false, example: 1 })
  @ApiQuery({ name: 'perPage', type: 'integer', required: false, example: 20 })
  @ApiResponse({ status: 200, type: () => NetworkMemberPageDto })
  members = async (req: Request, res: Response) => {
    const networkInput =
      (req.query.code as string) ||
      (req.query.networkId as string) ||
      '';
    const p = parsePagination(req.query as Record<string, unknown>);
    const { rows, total } = await this.networkService.listMembers(p, networkInput);
    // FE NetworkMemberModel is a flat shape. Mix `member` + `member.profile`
    // + `networkMember.joinedAt` into a single row.
    const data = rows.map(({ networkMember, member }) =>
      serializeNetworkMemberLegacy(member, networkMember.joinedAt),
    );
    return ok(res, buildLegacyPage(data, total, p));
  };

  @ApiOperation({
    summary: 'List tags of a network (or all networks if no code/networkId provided)',
  })
  @ApiQuery({ name: 'code', type: 'string', required: false, example: 'timeline-main' })
  @ApiQuery({
    name: 'networkId',
    type: 'string',
    required: false,
    example: 'network-uuid-1234',
  })
  @ApiQuery({ name: 'page', type: 'integer', required: false, example: 1 })
  @ApiQuery({ name: 'perPage', type: 'integer', required: false, example: 50 })
  @ApiQuery({
    name: 'keyword',
    type: 'string',
    required: false,
    description: 'Case-insensitive contains-match on tag name.',
  })
  @ApiQuery({
    name: 'sort',
    type: 'string',
    required: false,
    description: 'Reserved; currently ignored (always `name asc`).',
  })
  @ApiResponse({ status: 200, type: () => NetworkTagPageDto })
  tags = async (req: Request, res: Response) => {
    const networkInput =
      (req.query.code as string) ||
      (req.query.networkId as string) ||
      '';
    const keyword =
      typeof req.query.keyword === 'string' && req.query.keyword.length > 0
        ? req.query.keyword
        : undefined;
    const p = parsePagination(req.query as Record<string, unknown>);
    const { rows, total, countByTag } = await this.networkService.listTags(p, networkInput, keyword);
    // FE TagModel: `{tag, count, created}`. count = posts referencing
    // `#<tag>` in content (naive — no PostTag relation, see T3.5 note).
    const data = rows.map((t) => ({
      tag: t.name,
      count: countByTag.get(t.id) ?? 0,
      created: t.createdAt.toISOString(),
    }));
    return ok(res, buildLegacyPage(data, total, p));
  };
}
