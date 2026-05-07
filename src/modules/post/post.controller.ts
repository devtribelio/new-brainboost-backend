import type { Response } from 'express';
import { PostService } from './post.service';
import { ReportService } from '@/modules/report/report.service';
import { ok } from '@/common/utils/response.util';
import { BadRequestException, UnauthorizedException } from '@/common/exceptions';
import { buildLegacyPage, parsePagination } from '@/common/utils/pagination.util';
import { serializePost } from '@/common/serializers';
import type { AuthenticatedRequest } from '@/common/interfaces/authenticated-request';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@/common/openapi/decorators';

@ApiTags('Post')
export class PostController {
  constructor(
    private readonly postService: PostService,
    private readonly reportService: ReportService = new ReportService(),
  ) {}

  @ApiOperation({ summary: 'List posts (feed)' })
  @ApiQuery({ name: 'page', type: 'integer', required: false })
  @ApiQuery({ name: 'perPage', type: 'integer', required: false })
  @ApiQuery({ name: 'keyword', type: 'string', required: false })
  @ApiQuery({ name: 'networkId', type: 'string', required: false })
  @ApiQuery({ name: 'topicId', type: 'string', required: false })
  @ApiQuery({ name: 'memberId', type: 'string', required: false, description: 'Filter by author' })
  @ApiResponse({ status: 200 })
  list = async (req: AuthenticatedRequest, res: Response) => {
    const p = parsePagination(req.query as Record<string, unknown>);
    const q = req.query as Record<string, string | undefined>;
    const { rows, total } = await this.postService.list(p, {
      keyword: q.keyword,
      networkId: q.networkId,
      topicId: q.topicId,
      authorId: q.memberId,
      viewerId: req.user?.id,
    });

    const liked = req.user
      ? await this.postService.likedByMember(req.user.id, rows.map((r) => r.id))
      : new Set<string>();

    const data = rows.map((row) => serializePost(row, liked.has(row.id) ? 'like' : 'dislike'));
    return ok(res, buildLegacyPage(data, total, p));
  };

  @ApiOperation({ summary: 'Post detail (increments view count)' })
  @ApiQuery({ name: 'postId', type: 'string', required: true, description: 'legacyId or uuid' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'Not found' })
  detail = async (req: AuthenticatedRequest, res: Response) => {
    const postId = (req.query.postId as string) ?? '';
    if (!postId) throw new BadRequestException('postId required');
    const post = await this.postService.detail(postId, req.user?.id);
    const liked = req.user
      ? await this.postService.likedByMember(req.user.id, [post.id])
      : new Set<string>();
    return ok(res, serializePost(post, liked.has(post.id) ? 'like' : 'dislike'));
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Toggle like on a post' })
  @ApiResponse({ status: 200 })
  like = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const postId = (req.body?.postId as string) ?? '';
    if (!postId) throw new BadRequestException('postId required');
    const result = await this.postService.toggleLike(req.user.id, postId);
    return ok(res, result);
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a post' })
  @ApiResponse({ status: 201 })
  upsert = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const body = req.body ?? {};
    const post = await this.postService.create(req.user.id, {
      content: body.content ?? '',
      topicId: body.topicId,
      networkId: body.networkId,
      title: body.title,
      postType: body.postType,
      imageUrls: Array.isArray(body.images) ? body.images : body.imageUrls,
      videoUrl: body.videoUrl,
      embedUrl: body.embedUrl,
    });
    return ok(res, serializePost(post), undefined, 201);
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Soft-delete a post' })
  @ApiResponse({ status: 200 })
  remove = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const postId = (req.body?.postId as string) ?? (req.query.postId as string) ?? '';
    if (!postId) throw new BadRequestException('postId required');
    await this.postService.remove(req.user.id, postId);
    return ok(res, { postId, deleted: true });
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Report a post' })
  @ApiResponse({ status: 201 })
  report = async (req: AuthenticatedRequest, res: Response) => {
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
    return ok(res, r, undefined, 201);
  };
}
