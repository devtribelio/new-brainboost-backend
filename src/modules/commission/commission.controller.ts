import type { Request, Response } from 'express';
import { CommissionService } from './commission.service';
import { notImplemented } from '@/common/utils/response.util';

export class CommissionController {
  constructor(private readonly _commissionService: CommissionService) {}

  summary = async (_req: Request, res: Response) => notImplemented(res, 'commission.summary');
}
