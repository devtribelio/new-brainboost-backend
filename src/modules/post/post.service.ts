import { prisma } from '@/config/prisma';
import { BadRequestException, ForbiddenException, NotFoundException } from '@/common/exceptions';
import type { PaginationParams } from '@/common/utils/pagination.util';

interface PostListQuery {
  keyword?: string;
  networkId?: string;
  topicId?: string;
  authorId?: string;
  viewerId?: string;
}

interface PostCreateDto {
  content: string;
  topicId?: string;
  networkId?: string;
  title?: string;
  postType?: string;
  imageUrls?: string[];
  videoUrl?: string;
  embedUrl?: string;
}

const MAX_CONTENT_CHARS = 10000;
const MAX_IMAGE_COUNT = 8;
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

const postInclude = {
  author: true,
  topic: true,
} as const;

export class PostService {
  async list(p: PaginationParams, q: PostListQuery) {
    const where: Record<string, unknown> = {
      isDeleted: false,
      publishStatus: 'PUBLISHED',
    };
    if (q.keyword) where.content = { contains: q.keyword, mode: 'insensitive' };
    if (q.topicId) where.topicId = q.topicId;
    if (q.authorId) where.authorId = q.authorId;

    if (q.networkId) {
      where.networkId = q.networkId;
      if (q.viewerId) {
        await this.assertNetworkVisible(q.networkId, q.viewerId);
      }
    } else if (q.viewerId) {
      const visibleNetworkIds = await this.visibleNetworkIds(q.viewerId);
      where.OR = [
        { networkId: null },
        { networkId: { in: visibleNetworkIds } },
      ];
    } else {
      where.networkId = null;
    }

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

  async detail(id: string, viewerId?: string) {
    const post = await this.resolveByAnyId(id);
    if (!post || post.isDeleted) throw new NotFoundException('Post not found');
    if (post.publishStatus !== 'PUBLISHED' && post.authorId !== viewerId) {
      throw new ForbiddenException('Post is not published');
    }
    if (post.networkId && viewerId) {
      await this.assertNetworkVisible(post.networkId, viewerId);
    } else if (post.networkId && !viewerId) {
      const net = await prisma.network.findUnique({
        where: { id: post.networkId },
        select: { isPublic: true, isActive: true },
      });
      if (!net?.isActive || !net?.isPublic) {
        throw new ForbiddenException('Network not visible');
      }
    }
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

  async toggleLike(
    memberId: string,
    postId: string,
  ): Promise<{ status: 'like' | 'dislike'; countLike: number }> {
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
      return { status: 'dislike', countLike: Math.max(0, post.countLike - 1) };
    }

    await prisma.$transaction([
      prisma.postLike.create({ data: { postId: post.id, memberId } }),
      prisma.post.update({
        where: { id: post.id },
        data: { countLike: { increment: 1 } },
      }),
    ]);
    return { status: 'like', countLike: post.countLike + 1 };
  }

  async create(memberId: string, dto: PostCreateDto) {
    const member = await prisma.member.findUnique({ where: { id: memberId } });
    if (!member) throw new NotFoundException('Member not found');
    if (!member.isActive) throw new ForbiddenException('Member is not active');
    if (member.isMuted) throw new ForbiddenException('Member is muted from posting');

    const content = dto.content?.trim() ?? '';
    const imageUrls = dto.imageUrls ?? [];
    if (!content && imageUrls.length === 0 && !dto.videoUrl) {
      throw new BadRequestException('Post must have content, image, or video');
    }
    if (content.length > MAX_CONTENT_CHARS) {
      throw new BadRequestException(`Content exceeds ${MAX_CONTENT_CHARS} characters`);
    }
    if (imageUrls.length > MAX_IMAGE_COUNT) {
      throw new BadRequestException(`Maximum ${MAX_IMAGE_COUNT} images per post`);
    }

    if (dto.networkId) {
      await this.assertNetworkPostable(dto.networkId, memberId);
    }

    if (dto.topicId) {
      const topic = await prisma.topic.findUnique({ where: { id: dto.topicId } });
      if (!topic || !topic.isActive) throw new BadRequestException('Topic not available');
      if (topic.networkId && topic.networkId !== dto.networkId) {
        throw new BadRequestException('Topic does not belong to specified network');
      }
      if (topic.type === 'PRIVATE') {
        const sub = await prisma.topicSubscription.findUnique({
          where: { memberId_topicId: { memberId, topicId: topic.id } },
        });
        if (!sub) throw new ForbiddenException('Must subscribe to private topic before posting');
      }
    }

    const dupSince = new Date(Date.now() - DUPLICATE_WINDOW_MS);
    const dup = await prisma.post.findFirst({
      where: {
        authorId: memberId,
        content,
        createdAt: { gte: dupSince },
        isDeleted: false,
      },
      select: { id: true },
    });
    if (dup) throw new BadRequestException('Duplicate post within 10-minute window');

    const post = await prisma.post.create({
      data: {
        authorId: memberId,
        topicId: dto.topicId ?? null,
        networkId: dto.networkId ?? null,
        title: dto.title ?? null,
        content,
        postType: dto.postType ?? 'status',
        excerpt: content.slice(0, 200),
        imageUrls,
        videoUrl: dto.videoUrl ?? null,
        embedUrl: dto.embedUrl ?? null,
        publishStatus: 'PUBLISHED',
        engagedAt: new Date(),
      },
      include: postInclude,
    });
    return post;
  }

  async remove(memberId: string, postId: string) {
    const post = await this.resolveByAnyId(postId);
    if (!post) throw new NotFoundException('Post not found');

    let allowed = post.authorId === memberId;
    if (!allowed && post.networkId) {
      const isTeam = await this.isNetworkTeam(post.networkId, memberId);
      if (isTeam) allowed = true;
    }
    if (!allowed) throw new ForbiddenException('Not allowed to delete this post');

    await prisma.post.update({
      where: { id: post.id },
      data: { isDeleted: true },
    });
    return post;
  }

  private async visibleNetworkIds(memberId: string): Promise<string[]> {
    const [memberNets, publicNets] = await Promise.all([
      prisma.networkMember.findMany({
        where: { memberId },
        select: { networkId: true },
      }),
      prisma.network.findMany({
        where: { isPublic: true, isActive: true },
        select: { id: true },
      }),
    ]);
    return Array.from(new Set([...memberNets.map((m) => m.networkId), ...publicNets.map((n) => n.id)]));
  }

  private async assertNetworkVisible(networkId: string, memberId: string) {
    const net = await prisma.network.findUnique({
      where: { id: networkId },
      select: { id: true, isPublic: true, isActive: true },
    });
    if (!net) throw new NotFoundException('Network not found');
    if (!net.isActive) throw new ForbiddenException('Network is not active');
    if (net.isPublic) return;
    const joined = await prisma.networkMember.findUnique({
      where: { networkId_memberId: { networkId, memberId } },
    });
    if (!joined) throw new ForbiddenException('Network not visible to viewer');
  }

  private async assertNetworkPostable(networkId: string, memberId: string) {
    const net = await prisma.network.findUnique({
      where: { id: networkId },
      select: { isActive: true },
    });
    if (!net?.isActive) throw new BadRequestException('Network is not active');
    const joined = await prisma.networkMember.findUnique({
      where: { networkId_memberId: { networkId, memberId } },
    });
    if (!joined) throw new ForbiddenException('Must be a member of the network to post');
    const banned = await prisma.networkBannedMember.findUnique({
      where: { networkId_memberId: { networkId, memberId } },
    });
    if (banned) throw new ForbiddenException('Member is banned from this network');
  }

  private async isNetworkTeam(networkId: string, memberId: string): Promise<boolean> {
    const team = await prisma.networkTeamMember.findUnique({
      where: { networkId_memberId: { networkId, memberId } },
    });
    return !!team;
  }
}
