import { Prisma } from '@prisma/client';
import { prisma } from '@bb/db';
import { BadRequestException, ForbiddenException, NotFoundException } from '@bb/common/exceptions';
import type { PaginationParams } from '@bb/common/utils/pagination.util';
import { notificationEvents } from '@bb/common/events/notification-events';
import { assertUuid } from '@bb/common/utils/uuid.util';
import { PUBLISHED_STATUS, PUBLISHED_STATUS_FILTER, isPublished } from '@bb/common/utils/post-status.util';

interface PostListQuery {
  keyword?: string;
  networkId?: string;
  topicIds?: string[];
  authorId?: string;
  viewerId?: string;
  tag?: string;
  sortBy?: string;
  filter?: string;
}

type PostOrderBy =
  | { createdAt: 'asc' | 'desc' }
  | { engagedAt: 'desc' }
  | Array<{ countLike: 'desc' } | { createdAt: 'desc' }>;

function orderByFor(sortBy: string | undefined, filter: string | undefined): PostOrderBy {
  // Filter takes precedence — `recent-engagement` overrides sortBy.
  if (filter === 'recent-engagement') return { engagedAt: 'desc' };
  switch (sortBy) {
    case 'oldest':
      return { createdAt: 'asc' };
    case 'popular':
      return [{ countLike: 'desc' }, { createdAt: 'desc' }];
    case 'newest':
    default:
      return { createdAt: 'desc' };
  }
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
      publishStatus: PUBLISHED_STATUS_FILTER,
    };

    // `keyword` wins over `tag` when both provided (free-text > hashtag match).
    if (q.keyword) {
      where.content = { contains: q.keyword, mode: 'insensitive' };
    } else if (q.tag) {
      // No PostTag relation in schema. Naive inline-hashtag match against
      // post.content. Real tag system would need a join table — out of scope.
      const tag = q.tag.startsWith('#') ? q.tag : `#${q.tag}`;
      where.content = { contains: tag, mode: 'insensitive' };
    }
    if (q.topicIds && q.topicIds.length > 0) {
      where.topicId = q.topicIds.length === 1 ? q.topicIds[0] : { in: q.topicIds };
    }
    if (q.authorId) where.authorId = q.authorId;
    if (q.filter === 'pinned') where.isPinned = true;
    if (q.filter === 'curated') where.isCurated = true;
    // "Post admin" — posts flagged isAdminPost.
    if (q.filter === 'admin') where.isAdminPost = true;
    // "Post saya" — viewer's own posts. Overrides authorId/memberId param.
    if (q.filter === 'mine' && q.viewerId) where.authorId = q.viewerId;

    if (q.networkId) {
      where.networkId = q.networkId;
      if (q.viewerId) {
        await this.assertNetworkVisible(q.networkId, q.viewerId);
      }
    } else if (q.viewerId) {
      const visibleNetworkIds = await this.visibleNetworkIds(q.viewerId);
      where.OR = [{ networkId: null }, { networkId: { in: visibleNetworkIds } }];
    } else {
      where.networkId = null;
    }

    const [rows, total] = await Promise.all([
      prisma.post.findMany({
        where,
        include: postInclude,
        orderBy: orderByFor(q.sortBy, q.filter),
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
    assertUuid(id);
    return prisma.post.findUnique({ where: { id }, include: postInclude });
  }

  async detail(id: string, viewerId?: string) {
    const post = await this.resolveByAnyId(id);
    if (!post || post.isDeleted) throw new NotFoundException('Post not found');
    if (!isPublished(post.publishStatus) && post.authorId !== viewerId) {
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
  ): Promise<{ isLiked: boolean; countLike: number }> {
    const post = await this.resolveByAnyId(postId);
    if (!post) throw new NotFoundException('Post not found');
    if (post.networkId) await this.assertNetworkAccess(post.networkId, memberId);

    const result = await prisma.$transaction(async (tx) => {
      const deleted = await tx.postLike.deleteMany({
        where: { postId: post.id, memberId },
      });
      if (deleted.count > 0) {
        const updated = await tx.post.update({
          where: { id: post.id },
          data: { countLike: { decrement: 1 } },
          select: { countLike: true },
        });
        return { isLiked: false, countLike: Math.max(0, updated.countLike), notify: false };
      }

      try {
        await tx.postLike.create({ data: { postId: post.id, memberId } });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          // Concurrent like landed first. Read current count, don't double-increment.
          const current = await tx.post.findUnique({
            where: { id: post.id },
            select: { countLike: true },
          });
          return { isLiked: true, countLike: current?.countLike ?? 0, notify: false };
        }
        throw e;
      }
      const updated = await tx.post.update({
        where: { id: post.id },
        data: { countLike: { increment: 1 } },
        select: { countLike: true },
      });
      return { isLiked: true, countLike: updated.countLike, notify: true };
    });

    if (result.notify) {
      notificationEvents.emit('post.liked', {
        postId: post.id,
        postAuthorId: post.authorId,
        actorId: memberId,
      });
    }
    return { isLiked: result.isLiked, countLike: result.countLike };
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
        publishStatus: PUBLISHED_STATUS,
        engagedAt: new Date(),
      },
      include: postInclude,
    });
    notificationEvents.emit('post.published', {
      postId: post.id,
      authorId: post.authorId,
      networkId: post.networkId,
      excerpt: post.excerpt ?? '',
    });
    return post;
  }

  async setCurated(postId: string, isCurated: boolean) {
    const post = await this.resolveByAnyId(postId);
    if (!post) throw new NotFoundException('Post not found');
    return prisma.post.update({
      where: { id: post.id },
      data: { isCurated },
      include: postInclude,
    });
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
    return Array.from(
      new Set([...memberNets.map((m) => m.networkId), ...publicNets.map((n) => n.id)]),
    );
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

  // Asserts the caller is a NetworkMember of the tribe and is not muted there.
  // Mirrors legacy TBApi::isMemberJoined + validateMemberMuteNetwork. Does not
  // check banned — bans are handled separately at write paths.
  private async assertNetworkAccess(networkId: string, memberId: string) {
    const m = await prisma.networkMember.findUnique({
      where: { networkId_memberId: { networkId, memberId } },
      select: { isMuted: true },
    });
    if (!m) throw new ForbiddenException('Must be a member of the network');
    if (m.isMuted) throw new ForbiddenException('Muted in this network');
  }

  private async assertNetworkPostable(networkId: string, memberId: string) {
    const net = await prisma.network.findUnique({
      where: { id: networkId },
      select: { isActive: true },
    });
    if (!net?.isActive) throw new BadRequestException('Network is not active');
    const joined = await prisma.networkMember.findUnique({
      where: { networkId_memberId: { networkId, memberId } },
      select: { isMuted: true },
    });
    if (!joined) throw new ForbiddenException('Must be a member of the network to post');
    if (joined.isMuted) throw new ForbiddenException('Muted in this network');
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
