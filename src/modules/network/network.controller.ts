import type { Request, Response } from 'express';
import { NetworkService } from './network.service';
import { ok } from '@/common/utils/response.util';
import { BadRequestException, UnauthorizedException } from '@/common/exceptions';
import { buildLegacyPage, parsePagination } from '@/common/utils/pagination.util';
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

  @ApiOperation({ summary: 'List members of a network' })
  @ApiQuery({ name: 'code', type: 'string', required: false })
  @ApiQuery({ name: 'networkId', type: 'string', required: false })
  @ApiQuery({ name: 'page', type: 'integer', required: false })
  @ApiQuery({ name: 'perPage', type: 'integer', required: false })
  @ApiResponse({ status: 200 })
  members = async (req: Request, res: Response) => {
    const networkInput =
      (req.query.code as string) ||
      (req.query.networkId as string) ||
      '';
    if (!networkInput) throw new BadRequestException('code or networkId required');
    const p = parsePagination(req.query as Record<string, unknown>);
    const { rows, total } = await this.networkService.listMembers(p, networkInput);
    const data = rows.map(({ networkMember, member }) => ({
      networkMemberId: networkMember.legacyId ?? networkMember.id,
      joinedAt: networkMember.joinedAt,
      member: serializeMember(member),
    }));
    return ok(res, buildLegacyPage(data, total, p));
  };

  @ApiOperation({ summary: 'List tags of a network' })
  @ApiQuery({ name: 'code', type: 'string', required: false })
  @ApiQuery({ name: 'networkId', type: 'string', required: false })
  @ApiResponse({ status: 200 })
  tags = async (req: Request, res: Response) => {
    const networkInput =
      (req.query.code as string) ||
      (req.query.networkId as string) ||
      '';
    if (!networkInput) throw new BadRequestException('code or networkId required');
    const p = parsePagination(req.query as Record<string, unknown>);
    const { rows, total } = await this.networkService.listTags(p, networkInput);
    return ok(
      res,
      buildLegacyPage(
        rows.map((t) => ({ id: t.id, networkId: t.networkId, name: t.name })),
        total,
        p,
      ),
    );
  };
}
