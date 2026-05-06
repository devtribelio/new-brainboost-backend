import type { Response } from 'express';
import { MemberService } from './member.service';
import { ok } from '@/common/utils/response.util';
import type { AuthenticatedRequest } from '@/common/interfaces/authenticated-request';
import { UnauthorizedException } from '@/common/exceptions';

export class MemberController {
  constructor(private readonly memberService: MemberService) {}

  info = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const member = await this.memberService.findById(req.user.id);
    return ok(res, member);
  };
}
