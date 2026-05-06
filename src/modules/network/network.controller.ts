import type { Request, Response } from 'express';
import { NetworkService } from './network.service';
import { ok } from '@/common/utils/response.util';
import { BadRequestException, UnauthorizedException } from '@/common/exceptions';
import { buildPageMeta, parsePagination } from '@/common/utils/pagination.util';
import { serializeMember } from '@/common/serializers';
import type { AuthenticatedRequest } from '@/common/interfaces/authenticated-request';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@/common/openapi/decorators';

@ApiTags('Network')
export class NetworkController {
  constructor(private readonly networkService: NetworkService) {}

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Join / leave a network' })
  @ApiResponse({ status: 200 })
  join = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const networkId = (req.body?.networkId as string) ?? '';
    if (!networkId) throw new BadRequestException('networkId required');
    const action = (req.body?.action as string) ?? 'join';
    if (action === 'leave') {
      return ok(res, await this.networkService.leave(req.user.id, networkId));
    }
    return ok(res, await this.networkService.join(req.user.id, networkId));
  };

  @ApiOperation({ summary: 'List members of a network' })
  @ApiQuery({ name: 'networkId', type: 'string', required: true })
  @ApiQuery({ name: 'page', type: 'integer', required: false })
  @ApiQuery({ name: 'perPage', type: 'integer', required: false })
  @ApiResponse({ status: 200 })
  members = async (req: Request, res: Response) => {
    const networkId = (req.query.networkId as string) ?? '';
    if (!networkId) throw new BadRequestException('networkId required');
    const p = parsePagination(req.query as Record<string, unknown>);
    const { rows, total } = await this.networkService.listMembers(p, networkId);
    const data = rows.map(({ networkMember, member }) => ({
      networkMemberId: networkMember.legacyId ?? networkMember.id,
      joinedAt: networkMember.joinedAt,
      member: serializeMember(member),
    }));
    return ok(res, data, buildPageMeta(total, p));
  };

  @ApiOperation({ summary: 'List tags of a network' })
  @ApiQuery({ name: 'networkId', type: 'string', required: true })
  @ApiResponse({ status: 200 })
  tags = async (req: Request, res: Response) => {
    const networkId = (req.query.networkId as string) ?? '';
    if (!networkId) throw new BadRequestException('networkId required');
    const p = parsePagination(req.query as Record<string, unknown>);
    const { rows, total } = await this.networkService.listTags(p, networkId);
    return ok(
      res,
      rows.map((t) => ({ id: t.id, networkId: t.networkId, name: t.name })),
      buildPageMeta(total, p),
    );
  };
}
