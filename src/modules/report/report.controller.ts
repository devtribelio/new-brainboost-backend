import type { Request, Response } from 'express';
import { ReportService } from './report.service';
import { notImplemented } from '@/common/utils/response.util';

export class ReportController {
  constructor(private readonly _reportService: ReportService) {}

  categories = async (_req: Request, res: Response) => notImplemented(res, 'report.categories');
  memberReport = async (_req: Request, res: Response) => notImplemented(res, 'report.memberReport');
}
