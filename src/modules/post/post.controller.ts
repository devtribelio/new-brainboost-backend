import type { Response } from 'express';
import { PostService } from './post.service';
import { ReportService } from '@/modules/report/report.service';
import { ok, okCreated, okPaginated } from '@/common/utils/response.util';
import { BadRequestException, UnauthorizedException } from '@/common/exceptions';
import { parsePagination } from '@/common/utils/pagination.util';
import { serializePost } from './post.serializer';
import type { AuthenticatedRequest } from '@/common/interfaces/authenticated-request';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@/common/openapi/decorators';
import { ErrorEnvelopeDto } from '@/common/openapi/common.dto';
import {
  PostCreateBodyDto,
  PostDeleteBodyDto,
  PostDeleteResultDto,
  PostDto,
  PostLikeBodyDto,
  PostLikeToggleResultDto,
  PostReportBodyDto,
} from './dto/post.dto';
import { ReportResultDto } from '@/modules/report/dto/report.dto';

@ApiTags('Post')
export class PostController {
  constructor(
    private readonly postService: PostService,
    private readonly reportService: ReportService = new ReportService(),
  ) {}

  @ApiBearerAuth()
  @ApiOperation({ summary: 'List posts (feed)' })
  @ApiQuery({ name: 'page', type: 'integer', required: false, example: 1 })
  @ApiQuery({ name: 'perPage', type: 'integer', required: false, example: 20 })
  @ApiQuery({ name: 'keyword', type: 'string', required: false, example: 'react' })
  @ApiQuery({ name: 'networkId', type: 'string', required: false, example: 'network-uuid-1234' })
  @ApiQuery({ name: 'topicId', type: 'string', required: false, example: 'topic-uuid-1234' })
  @ApiQuery({
    name: 'memberId',
    type: 'string',
    required: false,
    example: 'member-uuid-1234',
    description: 'Filter by author',
  })
  @ApiQuery({
    name: 'tag',
    type: 'string',
    required: false,
    example: 'react',
    description: 'Naive #hashtag match against post content. Ignored when `keyword` is set.',
  })
  @ApiQuery({
    name: 'sortBy',
    type: 'string',
    required: false,
    example: 'newest',
    description: 'newest (default) | oldest | popular. Unknown values fall back to newest.',
  })
  @ApiQuery({
    name: 'filter',
    type: 'string',
    required: false,
    example: 'pinned',
    description: 'pinned | recent-engagement | curated. Unknown values are no-op.',
  })
  @ApiResponse({ status: 200, type: () => PostDto, isArray: true, envelope: 'paginated' })
  list = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const p = parsePagination(req.query as Record<string, unknown>);
    const q = req.query as Record<string, string | undefined>;
    const { rows, total } = await this.postService.list(p, {
      keyword: q.keyword,
      networkId: q.networkId,
      topicId: q.topicId,
      authorId: q.memberId,
      viewerId: req.user.id,
      tag: q.tag,
      sortBy: q.sortBy,
      filter: q.filter,
    });

    const liked = await this.postService.likedByMember(
      req.user.id,
      rows.map((r) => r.id),
    );

    const data = rows.map((row) => serializePost(row, liked.has(row.id)));
    return okPaginated(res, data, { page: p.page, perPage: p.perPage, total });
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Post detail (increments view count)' })
  @ApiQuery({
    name: 'postId',
    type: 'string',
    required: true,
    example: '789',
    description: 'legacyId or uuid',
  })
  @ApiResponse({ status: 200, type: () => PostDto })
  @ApiResponse({ status: 404, description: 'Not found', type: () => ErrorEnvelopeDto, envelope: 'none' })
  detail = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const postId = (req.query.postId as string) ?? '';
    if (!postId) throw new BadRequestException('postId required');
    const post = await this.postService.detail(postId, req.user.id);
    const liked = await this.postService.likedByMember(req.user.id, [post.id]);
    return ok(res, serializePost(post, liked.has(post.id)));
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Toggle like on a post' })
  @ApiBody({ type: () => PostLikeBodyDto })
  @ApiResponse({ status: 200, type: () => PostLikeToggleResultDto })
  like = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const postId = (req.body?.postId as string) ?? '';
    if (!postId) throw new BadRequestException('postId required');
    const result = await this.postService.toggleLike(req.user.id, postId);
    // commentId always null for post-like (FE LikeModel parity).
    return ok(res, { isLiked: result.isLiked, commentId: null, countLike: result.countLike });
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a post' })
  @ApiBody({ type: () => PostCreateBodyDto })
  @ApiResponse({ status: 201, type: () => PostDto })
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
    return okCreated(res, serializePost(post));
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Soft-delete a post' })
  @ApiBody({ type: () => PostDeleteBodyDto })
  @ApiResponse({ status: 200, type: () => PostDeleteResultDto })
  remove = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const postId = (req.body?.postId as string) ?? (req.query.postId as string) ?? '';
    if (!postId) throw new BadRequestException('postId required');
    await this.postService.remove(req.user.id, postId);
    return ok(res, { postId, deleted: true });
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Report a post' })
  @ApiBody({ type: () => PostReportBodyDto })
  @ApiResponse({ status: 201, type: () => ReportResultDto })
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
    return okCreated(res, r);
  };
}
