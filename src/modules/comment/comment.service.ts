import { prisma } from '@/config/prisma';
import { BadRequestException, ForbiddenException, NotFoundException } from '@/common/exceptions';
import type { PaginationParams } from '@/common/utils/pagination.util';

const MAX_CONTENT_CHARS = 5000;

const commentInclude = {
  author: true,
  parent: { select: { legacyId: true } },
  post: { select: { legacyId: true } },
} as const;

function sanitizeContent(input: string): string {
  return input
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<\/?[^>]+>/g, '')
    .trim();
}

export class CommentService {
  private async resolvePostId(input: string): Promise<string | null> {
    const legacyId = Number.parseInt(input, 10);
    if (Number.isFinite(legacyId) && input === String(legacyId)) {
      const byLegacy = await prisma.post.findUnique({ where: { legacyId }, select: { id: true } });
      if (byLegacy) return byLegacy.id;
    }
    const byId = await prisma.post.findUnique({ where: { id: input }, select: { id: true } });
    return byId?.id ?? null;
  }

  private async resolveCommentByAnyId(id: string) {
    const legacyId = Number.parseInt(id, 10);
    if (Number.isFinite(legacyId) && id === String(legacyId)) {
      const byLegacy = await prisma.comment.findUnique({
        where: { legacyId },
        include: commentInclude,
      });
      if (byLegacy) return byLegacy;
    }
    return prisma.comment.findUnique({ where: { id }, include: commentInclude });
  }

  async listForPost(p: PaginationParams, postIdInput: string) {
    const postId = await this.resolvePostId(postIdInput);
    if (!postId) return { rows: [], total: 0 };
    const where = { postId, parentId: null, isDeleted: false };
    const [rows, total] = await Promise.all([
      prisma.comment.findMany({
        where,
        include: commentInclude,
        orderBy: { createdAt: 'desc' },
        skip: p.skip,
        take: p.take,
      }),
      prisma.comment.count({ where }),
    ]);
    return { rows, total };
  }

  async listReplies(p: PaginationParams, parentInput: string) {
    const parent = await this.resolveCommentByAnyId(parentInput);
    if (!parent) return { rows: [], total: 0 };
    const where = { parentId: parent.id, isDeleted: false };
    const [rows, total] = await Promise.all([
      prisma.comment.findMany({
        where,
        include: commentInclude,
        orderBy: { createdAt: 'asc' },
        skip: p.skip,
        take: p.take,
      }),
      prisma.comment.count({ where }),
    ]);
    return { rows, total };
  }

  async detail(id: string) {
    const c = await this.resolveCommentByAnyId(id);
    if (!c || c.isDeleted) throw new NotFoundException('Comment not found');
    return c;
  }

  async likedByMember(memberId: string, commentIds: string[]): Promise<Set<string>> {
    if (commentIds.length === 0) return new Set();
    const rows = await prisma.commentLike.findMany({
      where: { memberId, commentId: { in: commentIds } },
      select: { commentId: true },
    });
    return new Set(rows.map((r) => r.commentId));
  }

  async toggleLike(
    memberId: string,
    commentInput: string,
  ): Promise<{ status: 'like' | 'dislike'; commentLegacyId: number | null; countLike: number }> {
    const c = await this.resolveCommentByAnyId(commentInput);
    if (!c) throw new NotFoundException('Comment not found');
    const existing = await prisma.commentLike.findUnique({
      where: { commentId_memberId: { commentId: c.id, memberId } },
    });
    if (existing) {
      await prisma.$transaction([
        prisma.commentLike.delete({ where: { id: existing.id } }),
        prisma.comment.update({ where: { id: c.id }, data: { countLike: { decrement: 1 } } }),
      ]);
      return { status: 'dislike', commentLegacyId: c.legacyId, countLike: Math.max(0, c.countLike - 1) };
    }
    await prisma.$transaction([
      prisma.commentLike.create({ data: { commentId: c.id, memberId } }),
      prisma.comment.update({ where: { id: c.id }, data: { countLike: { increment: 1 } } }),
    ]);
    return { status: 'like', commentLegacyId: c.legacyId, countLike: c.countLike + 1 };
  }

  async create(memberId: string, dto: {
    postId: string;
    content: string;
    parentId?: string;
    imageUrls?: string[];
  }) {
    const member = await prisma.member.findUnique({ where: { id: memberId } });
    if (!member) throw new NotFoundException('Member not found');
    if (!member.isActive) throw new ForbiddenException('Member is not active');
    if (member.isMuted) throw new ForbiddenException('Member is muted');

    const sanitized = sanitizeContent(dto.content ?? '');
    const imageUrls = dto.imageUrls ?? [];
    if (!sanitized && imageUrls.length === 0) {
      throw new BadRequestException('Comment must have content or image');
    }
    if (sanitized.length > MAX_CONTENT_CHARS) {
      throw new BadRequestException(`Content exceeds ${MAX_CONTENT_CHARS} characters`);
    }

    const postId = await this.resolvePostId(dto.postId);
    if (!postId) throw new NotFoundException('Post not found');

    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: { isDeleted: true, publishStatus: true, networkId: true },
    });
    if (!post || post.isDeleted) throw new NotFoundException('Post not found');
    if (post.publishStatus !== 'PUBLISHED') {
      throw new BadRequestException('Cannot comment on unpublished post');
    }
    if (post.networkId) {
      const banned = await prisma.networkBannedMember.findUnique({
        where: { networkId_memberId: { networkId: post.networkId, memberId } },
      });
      if (banned) throw new ForbiddenException('Member is banned from network');
    }

    let parentId: string | null = null;
    if (dto.parentId) {
      const parent = await this.resolveCommentByAnyId(dto.parentId);
      if (!parent || parent.isDeleted) throw new NotFoundException('Parent comment not found');
      if (parent.postId !== postId) {
        throw new BadRequestException('Parent comment belongs to a different post');
      }
      parentId = parent.id;
    }

    const comment = await prisma.$transaction(async (tx) => {
      const created = await tx.comment.create({
        data: {
          postId,
          authorId: memberId,
          parentId,
          content: sanitized,
          imageUrls,
        },
        include: commentInclude,
      });
      if (parentId) {
        await tx.comment.update({
          where: { id: parentId },
          data: { countReplies: { increment: 1 } },
        });
        await tx.post.update({
          where: { id: postId },
          data: { countReplies: { increment: 1 }, engagedAt: new Date() },
        });
      } else {
        await tx.post.update({
          where: { id: postId },
          data: { countComment: { increment: 1 }, engagedAt: new Date() },
        });
      }
      return created;
    });
    return comment;
  }

  async update(memberId: string, commentInput: string, content: string) {
    const c = await this.resolveCommentByAnyId(commentInput);
    if (!c) throw new NotFoundException('Comment not found');
    if (c.isDeleted) throw new NotFoundException('Comment was deleted');
    if (c.authorId !== memberId) throw new ForbiddenException('Not the author');

    const sanitized = sanitizeContent(content ?? '');
    if (!sanitized && (c.imageUrls?.length ?? 0) === 0) {
      throw new BadRequestException('Comment must have content or image');
    }
    if (sanitized.length > MAX_CONTENT_CHARS) {
      throw new BadRequestException(`Content exceeds ${MAX_CONTENT_CHARS} characters`);
    }

    return prisma.comment.update({
      where: { id: c.id },
      data: { content: sanitized },
      include: commentInclude,
    });
  }

  async remove(memberId: string, commentInput: string) {
    const c = await this.resolveCommentByAnyId(commentInput);
    if (!c) throw new NotFoundException('Comment not found');

    let allowed = c.authorId === memberId;
    if (!allowed) {
      const post = await prisma.post.findUnique({
        where: { id: c.postId },
        select: { authorId: true, networkId: true },
      });
      if (post?.authorId === memberId) allowed = true;
      if (!allowed && post?.networkId) {
        const team = await prisma.networkTeamMember.findUnique({
          where: { networkId_memberId: { networkId: post.networkId, memberId } },
        });
        if (team) allowed = true;
      }
    }
    if (!allowed) throw new ForbiddenException('Not allowed to delete this comment');

    await prisma.$transaction(async (tx) => {
      await tx.comment.update({
        where: { id: c.id },
        data: { isDeleted: true },
      });
      if (c.parentId) {
        await tx.comment.update({
          where: { id: c.parentId },
          data: { countReplies: { decrement: 1 } },
        });
        await tx.post.update({
          where: { id: c.postId },
          data: { countReplies: { decrement: 1 } },
        });
      } else {
        await tx.post.update({
          where: { id: c.postId },
          data: { countComment: { decrement: 1 } },
        });
      }
    });

    return prisma.comment.findUnique({ where: { id: c.id }, include: commentInclude });
  }
}
