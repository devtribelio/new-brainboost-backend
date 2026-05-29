import type { Request, Response } from 'express';
import { NetworkService } from './network.service';
import { ok, okPaginated } from '@bb/common/utils/response.util';
import { BadRequestException, UnauthorizedException } from '@bb/common/exceptions';
import { parsePagination } from '@bb/common/utils/pagination.util';
import { serializeNetworkMemberLegacy } from './network.serializer';
import type { AuthenticatedRequest } from '@bb/common/interfaces/authenticated-request';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@bb/common/openapi/decorators';
import {
  NetworkJoinResultDto,
  NetworkMemberEntryDto,
  NetworkTagDto,
} from './dto/network.dto';
import { NetworkJoinBodyDto } from './dto/network-join-body.dto';
import { NetworkRequestActionDto } from './dto/network-request-action.dto';

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
  @ApiResponse({ status: 200, type: () => NetworkMemberEntryDto, isArray: true, envelope: 'paginated' })
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
    return okPaginated(res, data, { page: p.page, perPage: p.perPage, total });
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
  @ApiResponse({ status: 200, type: () => NetworkTagDto, isArray: true, envelope: 'paginated' })
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
    return okPaginated(res, data, { page: p.page, perPage: p.perPage, total });
  };

  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Approve a pending network join request (team-only)',
    description: 'Caller must be a NetworkTeamMember of the target network. Provide either `requestId` directly or `(code|networkId) + memberId`.',
  })
  @ApiBody({ type: () => NetworkRequestActionDto })
  approveRequest = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const body = req.body ?? {};
    const result = await this.networkService.approveRequest(req.user.id, {
      requestId: body.requestId,
      networkInput: body.networkId ?? body.code,
      memberId: body.memberId,
    });
    return ok(res, result);
  };

  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Reject a pending network join request (team-only)',
    description: 'Caller must be a NetworkTeamMember of the target network.',
  })
  @ApiBody({ type: () => NetworkRequestActionDto })
  rejectRequest = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const body = req.body ?? {};
    const result = await this.networkService.rejectRequest(req.user.id, {
      requestId: body.requestId,
      networkInput: body.networkId ?? body.code,
      memberId: body.memberId,
    });
    return ok(res, result);
  };
}
