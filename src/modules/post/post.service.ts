import { prisma } from '@/config/prisma';
import { BadRequestException, NotFoundException } from '@/common/exceptions';
import type { PaginationParams } from '@/common/utils/pagination.util';

interface PostListQuery {
  keyword?: string;
  networkId?: string;
  topicId?: string;
  authorId?: string;
}

const postInclude = {
  author: true,
  topic: true,
} as const;

export class PostService {
  async list(p: PaginationParams, q: PostListQuery) {
    const where: Record<string, unknown> = { isDeleted: false };
    if (q.keyword) where.content = { contains: q.keyword, mode: 'insensitive' };
    if (q.networkId) where.networkId = q.networkId;
    if (q.topicId) where.topicId = q.topicId;
    if (q.authorId) where.authorId = q.authorId;

    const [rows, total] = await Promise.all([
      prisma.post.findMany({
        where,
        include: postInclude,
        orderBy: { createdAt: 'desc' },
        skip: p.skip,
        take: p.take,
      }),
      prisma.post.count({ where }),
    ]);
    return { rows, total };
  }

  async resolveByAnyId(id: string) {
    const legacyId = Number.parseInt(id, 10);
    if (Number.isFinite(legacyId) && id === String(legacyId)) {
      const byLegacy = await prisma.post.findUnique({
        where: { legacyId },
        include: postInclude,
      });
      if (byLegacy) return byLegacy;
    }
    return prisma.post.findUnique({ where: { id }, include: postInclude });
  }

  async detail(id: string) {
    const post = await this.resolveByAnyId(id);
    if (!post || post.isDeleted) throw new NotFoundException('Post not found');
    await prisma.post.update({
      where: { id: post.id },
      data: { viewCount: { increment: 1 } },
    });
    return post;
  }

  async likedByMember(memberId: string, postIds: string[]): Promise<Set<string>> {
    if (postIds.length === 0) return new Set();
    const rows = await prisma.postLike.findMany({
      where: { memberId, postId: { in: postIds } },
      select: { postId: true },
    });
    return new Set(rows.map((r) => r.postId));
  }

  async toggleLike(memberId: string, postId: string): Promise<{ liked: boolean; countLike: number }> {
    const post = await this.resolveByAnyId(postId);
    if (!post) throw new NotFoundException('Post not found');

    const existing = await prisma.postLike.findUnique({
      where: { postId_memberId: { postId: post.id, memberId } },
    });
    if (existing) {
      await prisma.$transaction([
        prisma.postLike.delete({ where: { id: existing.id } }),
        prisma.post.update({
          where: { id: post.id },
          data: { countLike: { decrement: 1 } },
        }),
      ]);
      return { liked: false, countLike: Math.max(0, post.countLike - 1) };
    }

    await prisma.$transaction([
      prisma.postLike.create({ data: { postId: post.id, memberId } }),
      prisma.post.update({
        where: { id: post.id },
        data: { countLike: { increment: 1 } },
      }),
    ]);
    return { liked: true, countLike: post.countLike + 1 };
  }

  async create(memberId: string, dto: {
    content: string;
    topicId?: string;
    networkId?: string;
    title?: string;
    postType?: string;
    imageUrls?: string[];
    videoUrl?: string;
    embedUrl?: string;
  }) {
    if (!dto.content?.trim() && !dto.imageUrls?.length && !dto.videoUrl) {
      throw new BadRequestException('Post must have content, image, or video');
    }
    const post = await prisma.post.create({
      data: {
        authorId: memberId,
        topicId: dto.topicId ?? null,
        networkId: dto.networkId ?? null,
        title: dto.title ?? null,
        content: dto.content ?? '',
        postType: dto.postType ?? 'status',
        excerpt: dto.content?.slice(0, 200) ?? null,
        imageUrls: dto.imageUrls ?? [],
        videoUrl: dto.videoUrl ?? null,
        embedUrl: dto.embedUrl ?? null,
      },
      include: postInclude,
    });
    return post;
  }

  async remove(memberId: string, postId: string) {
    const post = await this.resolveByAnyId(postId);
    if (!post) throw new NotFoundException('Post not found');
    if (post.authorId !== memberId) throw new BadRequestException('Not the author');
    await prisma.post.update({
      where: { id: post.id },
      data: { isDeleted: true },
    });
    return post;
  }
}
