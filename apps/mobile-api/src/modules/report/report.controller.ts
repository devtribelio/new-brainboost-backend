import type { Request, Response } from 'express';
import { ReportService } from './report.service';
import { ok, okCreated } from '@bb/common/utils/response.util';
import { BadRequestException, UnauthorizedException } from '@bb/common/exceptions';
import type { AuthenticatedRequest } from '@bb/common/interfaces/authenticated-request';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@bb/common/openapi/decorators';
import { ReportCategoryDto, ReportMemberRequestDto, ReportResultDto } from './dto/report.dto';

@ApiTags('Report')
export class ReportController {
  constructor(private readonly reportService: ReportService) {}

  @ApiOperation({ summary: 'List active report categories' })
  @ApiResponse({ status: 200, type: () => ReportCategoryDto, isArray: true })
  categories = async (_req: Request, res: Response) => {
    const rows = await this.reportService.listCategories({ isActive: true });
    // FE ReportCategoryModel: {id, category, description}.
    // `description` not yet a column on report_categories — emit null.
    return ok(
      res,
      rows.map((c) => ({
        id: c.id,
        category: c.name,
        description: null,
      })),
    );
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Report a member' })
  @ApiBody({ type: () => ReportMemberRequestDto })
  @ApiResponse({ status: 201, type: () => ReportResultDto })
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
    return okCreated(res, r);
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Report a post' })
  @ApiResponse({ status: 201, type: () => ReportResultDto })
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
    return okCreated(res, r);
  };
}
