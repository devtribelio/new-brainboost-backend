import { prisma } from '@/config/prisma';
import { BadRequestException, NotFoundException } from '@/common/exceptions';
import type { PaginationParams } from '@/common/utils/pagination.util';

const commentInclude = { author: true } as const;

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

  async toggleLike(memberId: string, commentInput: string) {
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
      return { liked: false, countLike: Math.max(0, c.countLike - 1) };
    }
    await prisma.$transaction([
      prisma.commentLike.create({ data: { commentId: c.id, memberId } }),
      prisma.comment.update({ where: { id: c.id }, data: { countLike: { increment: 1 } } }),
    ]);
    return { liked: true, countLike: c.countLike + 1 };
  }

  async create(memberId: string, dto: {
    postId: string;
    content: string;
    parentId?: string;
    imageUrls?: string[];
  }) {
    if (!dto.content?.trim()) throw new BadRequestException('Content required');
    const postId = await this.resolvePostId(dto.postId);
    if (!postId) throw new NotFoundException('Post not found');
    let parentId: string | null = null;
    if (dto.parentId) {
      const parent = await this.resolveCommentByAnyId(dto.parentId);
      if (!parent) throw new NotFoundException('Parent comment not found');
      parentId = parent.id;
    }
    const comment = await prisma.$transaction(async (tx) => {
      const created = await tx.comment.create({
        data: {
          postId,
          authorId: memberId,
          parentId,
          content: dto.content,
          imageUrls: dto.imageUrls ?? [],
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
          data: { countReplies: { increment: 1 } },
        });
      } else {
        await tx.post.update({
          where: { id: postId },
          data: { countComment: { increment: 1 } },
        });
      }
      return created;
    });
    return comment;
  }

  async update(memberId: string, commentInput: string, content: string) {
    const c = await this.resolveCommentByAnyId(commentInput);
    if (!c) throw new NotFoundException('Comment not found');
    if (c.authorId !== memberId) throw new BadRequestException('Not the author');
    return prisma.comment.update({
      where: { id: c.id },
      data: { content },
      include: commentInclude,
    });
  }

  async remove(memberId: string, commentInput: string) {
    const c = await this.resolveCommentByAnyId(commentInput);
    if (!c) throw new NotFoundException('Comment not found');
    if (c.authorId !== memberId) throw new BadRequestException('Not the author');
    return prisma.comment.update({
      where: { id: c.id },
      data: { isDeleted: true },
      include: commentInclude,
    });
  }
}
