import type { Response } from 'express';
import { CommentService } from './comment.service';
import { ok } from '@/common/utils/response.util';
import { BadRequestException, UnauthorizedException } from '@/common/exceptions';
import { buildPageMeta, parsePagination } from '@/common/utils/pagination.util';
import { serializeComment } from '@/common/serializers';
import type { AuthenticatedRequest } from '@/common/interfaces/authenticated-request';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@/common/openapi/decorators';

@ApiTags('Comment')
export class CommentController {
  constructor(private readonly commentService: CommentService) {}

  @ApiOperation({ summary: 'List comments for a post (top-level only)' })
  @ApiQuery({ name: 'postId', type: 'string', required: true })
  @ApiQuery({ name: 'page', type: 'integer', required: false })
  @ApiQuery({ name: 'perPage', type: 'integer', required: false })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 400, description: 'postId required' })
  list = async (req: AuthenticatedRequest, res: Response) => {
    const postId = (req.query.postId as string) ?? '';
    if (!postId) throw new BadRequestException('postId required');
    const p = parsePagination(req.query as Record<string, unknown>);
    const { rows, total } = await this.commentService.listForPost(p, postId);
    const liked = req.user
      ? await this.commentService.likedByMember(req.user.id, rows.map((r) => r.id))
      : new Set<string>();
    const data = rows.map((row) =>
      serializeComment(row, liked.has(row.id) ? 'like' : 'dislike'),
    );
    return ok(res, data, buildPageMeta(total, p));
  };

  @ApiOperation({ summary: 'Comment detail' })
  @ApiQuery({ name: 'commentId', type: 'string', required: true })
  @ApiResponse({ status: 200 })
  detail = async (req: AuthenticatedRequest, res: Response) => {
    const commentId = (req.query.commentId as string) ?? '';
    if (!commentId) throw new BadRequestException('commentId required');
    const c = await this.commentService.detail(commentId);
    const liked = req.user
      ? await this.commentService.likedByMember(req.user.id, [c.id])
      : new Set<string>();
    return ok(res, serializeComment(c, liked.has(c.id) ? 'like' : 'dislike'));
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Toggle like on a comment' })
  @ApiResponse({ status: 200 })
  like = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const commentId = (req.body?.commentId as string) ?? '';
    if (!commentId) throw new BadRequestException('commentId required');
    return ok(res, await this.commentService.toggleLike(req.user.id, commentId));
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a comment (or reply when replyId is set)' })
  @ApiResponse({ status: 201 })
  create = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const body = req.body ?? {};
    const c = await this.commentService.create(req.user.id, {
      postId: body.postId,
      content: body.content ?? '',
      parentId: body.replyId ?? body.parentId,
      imageUrls: Array.isArray(body.images) ? body.images : body.imageUrls,
    });
    return ok(res, serializeComment(c), undefined, 201);
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update comment content' })
  @ApiResponse({ status: 200 })
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
  @ApiResponse({ status: 200 })
  remove = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const commentId = (req.body?.commentId as string) ?? (req.query.commentId as string) ?? '';
    if (!commentId) throw new BadRequestException('commentId required');
    await this.commentService.remove(req.user.id, commentId);
    return ok(res, { commentId, deleted: true });
  };
}
