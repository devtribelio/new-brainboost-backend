import type { Request, Response } from 'express';
import { ReportService } from './report.service';
import { ok } from '@/common/utils/response.util';
import { BadRequestException, UnauthorizedException } from '@/common/exceptions';
import type { AuthenticatedRequest } from '@/common/interfaces/authenticated-request';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@/common/openapi/decorators';

@ApiTags('Report')
export class ReportController {
  constructor(private readonly reportService: ReportService) {}

  @ApiOperation({ summary: 'List active report categories' })
  @ApiResponse({ status: 200 })
  categories = async (_req: Request, res: Response) => {
    const rows = await this.reportService.listCategories({ isActive: true });
    return ok(
      res,
      rows.map((c) => ({
        reportCategoryId: c.legacyId ?? c.id,
        id: c.id,
        name: c.name,
        isActive: c.isActive,
      })),
    );
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Report a member' })
  @ApiResponse({ status: 201 })
  memberReport = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const body = req.body ?? {};
    const targetMemberId = (body.memberId ?? body.targetId ?? body.targetMemberId) as string;
    const categoryId = (body.categoryId ?? body.reportCategoryId) as string;
    if (!targetMemberId || !categoryId) {
      throw new BadRequestException('memberId and categoryId required');
    }
    const r = await this.reportService.reportMember(req.user.id, {
      targetMemberId,
      categoryId,
      networkId: body.networkId,
      reason: body.reason,
    });
    return ok(res, r, undefined, 201);
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Report a post' })
  @ApiResponse({ status: 201 })
  postReport = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const body = req.body ?? {};
    const postId = body.postId as string;
    const categoryId = (body.categoryId ?? body.reportCategoryId) as string;
    if (!postId || !categoryId) {
      throw new BadRequestException('postId and categoryId required');
    }
    const r = await this.reportService.reportPost(req.user.id, {
      postId,
      categoryId,
      networkId: body.networkId,
      reason: body.reason,
    });
    return ok(res, r, undefined, 201);
  };
}
