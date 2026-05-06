import type { Response } from 'express';
import { ReplyService } from './reply.service';
import { ok } from '@/common/utils/response.util';
import { BadRequestException } from '@/common/exceptions';
import { buildPageMeta, parsePagination } from '@/common/utils/pagination.util';
import { serializeComment } from '@/common/serializers';
import type { AuthenticatedRequest } from '@/common/interfaces/authenticated-request';

export class ReplyController {
  constructor(private readonly replyService: ReplyService) {}

  list = async (req: AuthenticatedRequest, res: Response) => {
    const parent = (req.query.commentId as string) ?? (req.query.replyId as string) ?? '';
    if (!parent) throw new BadRequestException('commentId required');
    const p = parsePagination(req.query as Record<string, unknown>);
    const { rows, total } = await this.replyService.listReplies(p, parent);
    const liked = req.user
      ? await this.replyService.likedByMember(req.user.id, rows.map((r) => r.id))
      : new Set<string>();
    const data = rows.map((row) =>
      serializeComment(row, liked.has(row.id) ? 'like' : 'dislike'),
    );
    return ok(res, data, buildPageMeta(total, p));
  };
}
