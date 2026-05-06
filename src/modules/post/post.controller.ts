import type { Response } from 'express';
import { PostService } from './post.service';
import { ok } from '@/common/utils/response.util';
import { BadRequestException, UnauthorizedException } from '@/common/exceptions';
import { buildPageMeta, parsePagination } from '@/common/utils/pagination.util';
import { serializePost } from '@/common/serializers';
import type { AuthenticatedRequest } from '@/common/interfaces/authenticated-request';

export class PostController {
  constructor(private readonly postService: PostService) {}

  list = async (req: AuthenticatedRequest, res: Response) => {
    const p = parsePagination(req.query as Record<string, unknown>);
    const q = req.query as Record<string, string | undefined>;
    const { rows, total } = await this.postService.list(p, {
      keyword: q.keyword,
      networkId: q.networkId,
      topicId: q.topicId,
      authorId: q.memberId,
    });

    const liked = req.user
      ? await this.postService.likedByMember(req.user.id, rows.map((r) => r.id))
      : new Set<string>();

    const data = rows.map((row) => serializePost(row, liked.has(row.id) ? 'like' : 'dislike'));
    return ok(res, data, buildPageMeta(total, p));
  };

  detail = async (req: AuthenticatedRequest, res: Response) => {
    const postId = (req.query.postId as string) ?? '';
    if (!postId) throw new BadRequestException('postId required');
    const post = await this.postService.detail(postId);
    const liked = req.user
      ? await this.postService.likedByMember(req.user.id, [post.id])
      : new Set<string>();
    return ok(res, serializePost(post, liked.has(post.id) ? 'like' : 'dislike'));
  };

  like = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const postId = (req.body?.postId as string) ?? '';
    if (!postId) throw new BadRequestException('postId required');
    const result = await this.postService.toggleLike(req.user.id, postId);
    return ok(res, result);
  };

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

  remove = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const postId = (req.body?.postId as string) ?? (req.query.postId as string) ?? '';
    if (!postId) throw new BadRequestException('postId required');
    await this.postService.remove(req.user.id, postId);
    return ok(res, { postId, deleted: true });
  };

  report = async (_req: AuthenticatedRequest, res: Response) => {
    return ok(res, { ok: true, note: 'report endpoint accepts payload but persistence pending' });
  };
}
