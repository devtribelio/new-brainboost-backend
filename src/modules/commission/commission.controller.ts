import type { Response } from 'express';
import { CommissionService } from './commission.service';
import { ok } from '@/common/utils/response.util';
import { UnauthorizedException } from '@/common/exceptions';
import type { AuthenticatedRequest } from '@/common/interfaces/authenticated-request';

export class CommissionController {
  constructor(private readonly commissionService: CommissionService) {}

  summary = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    return ok(res, await this.commissionService.summary(req.user.id));
  };
}
