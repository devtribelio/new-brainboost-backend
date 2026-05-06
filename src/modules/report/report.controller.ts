import type { Request, Response } from 'express';
import { ReportService } from './report.service';
import { ok } from '@/common/utils/response.util';
import { BadRequestException, UnauthorizedException } from '@/common/exceptions';
import type { AuthenticatedRequest } from '@/common/interfaces/authenticated-request';

export class ReportController {
  constructor(private readonly reportService: ReportService) {}

  categories = async (_req: Request, res: Response) => {
    const rows = await this.reportService.listCategories();
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
      reason: body.reason,
    });
    return ok(res, { reportId: r.id, createdAt: r.createdAt }, undefined, 201);
  };
}
