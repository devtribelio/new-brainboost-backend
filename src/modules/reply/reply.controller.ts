import type { Response } from 'express';
import { ReplyService } from './reply.service';
import { okPaginated } from '@/common/utils/response.util';
import { BadRequestException } from '@/common/exceptions';
import { parsePagination } from '@/common/utils/pagination.util';
import { serializeComment } from '@/modules/comment/comment.serializer';
import type { AuthenticatedRequest } from '@/common/interfaces/authenticated-request';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@/common/openapi/decorators';
import { CommentDto } from '@/modules/comment/dto/comment.dto';

@ApiTags('Comment')
export class ReplyController {
  constructor(private readonly replyService: ReplyService) {}

  @ApiOperation({ summary: 'List replies of a comment' })
  @ApiQuery({ name: 'commentId', type: 'string', required: true, example: 'comment-uuid-parent' })
  @ApiQuery({ name: 'page', type: 'integer', required: false, example: 1 })
  @ApiQuery({ name: 'perPage', type: 'integer', required: false, example: 20 })
  @ApiResponse({ status: 200, type: () => CommentDto, isArray: true, envelope: 'paginated' })
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
    return okPaginated(res, data, { page: p.page, perPage: p.perPage, total });
  };
}
