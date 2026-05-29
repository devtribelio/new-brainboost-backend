import type { Response } from 'express';
import { CommentService } from './comment.service';
import { ok, okCreated, okPaginated } from '@bb/common/utils/response.util';
import { BadRequestException, UnauthorizedException } from '@bb/common/exceptions';
import { parsePagination } from '@bb/common/utils/pagination.util';
import { serializeComment } from './comment.serializer';
import type { AuthenticatedRequest } from '@bb/common/interfaces/authenticated-request';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@bb/common/openapi/decorators';
import { ErrorEnvelopeDto } from '@bb/common/openapi/common.dto';
import {
  CommentCreateBodyDto,
  CommentDeleteBodyDto,
  CommentDeleteResultDto,
  CommentDto,
  CommentLikeBodyDto,
  CommentLikeToggleResultDto,
  CommentUpdateBodyDto,
} from './dto/comment.dto';

@ApiTags('Comment')
export class CommentController {
  constructor(private readonly commentService: CommentService) {}

  @ApiOperation({ summary: 'List comments for a post (top-level only)' })
  @ApiQuery({ name: 'postId', type: 'string', required: true, example: 'post-uuid-1234' })
  @ApiQuery({ name: 'page', type: 'integer', required: false, example: 1 })
  @ApiQuery({ name: 'perPage', type: 'integer', required: false, example: 20 })
  @ApiResponse({ status: 200, type: () => CommentDto, isArray: true, envelope: 'paginated' })
  @ApiResponse({
    status: 400,
    description: 'postId required',
    type: () => ErrorEnvelopeDto,
    envelope: 'none',
  })
  list = async (req: AuthenticatedRequest, res: Response) => {
    const postId = (req.query.postId as string) ?? '';
    if (!postId) throw new BadRequestException('postId required');
    const p = parsePagination(req.query as Record<string, unknown>);
    const { rows, total } = await this.commentService.listForPost(p, postId);
    const liked = req.user
      ? await this.commentService.likedByMember(req.user.id, rows.map((r) => r.id))
      : new Set<string>();
    const data = rows.map((row) => serializeComment(row, liked.has(row.id)));
    return okPaginated(res, data, { page: p.page, perPage: p.perPage, total });
  };

  @ApiOperation({ summary: 'Comment detail' })
  @ApiQuery({ name: 'commentId', type: 'string', required: true, example: 'comment-uuid-1234' })
  @ApiResponse({ status: 200, type: () => CommentDto })
  detail = async (req: AuthenticatedRequest, res: Response) => {
    const commentId = (req.query.commentId as string) ?? '';
    if (!commentId) throw new BadRequestException('commentId required');
    const c = await this.commentService.detail(commentId);
    const liked = req.user
      ? await this.commentService.likedByMember(req.user.id, [c.id])
      : new Set<string>();
    return ok(res, serializeComment(c, liked.has(c.id)));
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Toggle like on a comment' })
  @ApiBody({ type: () => CommentLikeBodyDto })
  @ApiResponse({ status: 200, type: () => CommentLikeToggleResultDto })
  like = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const commentId = (req.body?.commentId as string) ?? '';
    if (!commentId) throw new BadRequestException('commentId required');
    const result = await this.commentService.toggleLike(req.user.id, commentId);
    // commentId = comment's legacyId int (null when unmigrated).
    return ok(res, {
      isLiked: result.isLiked,
      commentId: result.commentLegacyId,
      countLike: result.countLike,
    });
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a comment (or reply when replyId is set)' })
  @ApiBody({ type: () => CommentCreateBodyDto })
  @ApiResponse({ status: 201, type: () => CommentDto })
  create = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const body = req.body ?? {};
    const c = await this.commentService.create(req.user.id, {
      postId: body.postId,
      content: body.content ?? '',
      parentId: body.replyId ?? body.parentId,
      imageUrls: Array.isArray(body.images) ? body.images : body.imageUrls,
    });
    return okCreated(res, serializeComment(c));
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update comment content' })
  @ApiBody({ type: () => CommentUpdateBodyDto })
  @ApiResponse({ status: 200, type: () => CommentDto })
  update = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const body = req.body ?? {};
    const commentId = body.commentId as string;
    const content = body.content as string;
    if (!commentId || !content) throw new BadRequestException('commentId and content required');
    const c = await this.commentService.update(req.user.id, commentId, content);
    return ok(res, serializeComment(c));
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Soft-delete a comment' })
  @ApiBody({ type: () => CommentDeleteBodyDto })
  @ApiResponse({ status: 200, type: () => CommentDeleteResultDto })
  remove = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const commentId = (req.body?.commentId as string) ?? (req.query.commentId as string) ?? '';
    if (!commentId) throw new BadRequestException('commentId required');
    await this.commentService.remove(req.user.id, commentId);
    return ok(res, { commentId, deleted: true });
  };
}
