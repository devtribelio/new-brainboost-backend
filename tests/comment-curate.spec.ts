import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { CommentService } from '@/modules/comment/comment.service';
import { NotFoundException } from '@bb/common/exceptions';

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

describe('CommentService.setCurated', () => {
  const commentService = new CommentService();
  let memberId = '';
  let postId = '';
  let topId = '';
  let replyId = '';

  beforeAll(async () => {
    const m = await prisma.member.create({
      data: { email: `c-curate-${uid()}@test.local`, passwordHash: await bcrypt.hash('s', 4) },
    });
    memberId = m.id;
    const p = await prisma.post.create({
      data: { authorId: memberId, content: `host ${uid()}`, publishStatus: 'PUBLISHED' },
    });
    postId = p.id;
    const top = await prisma.comment.create({
      data: { postId, authorId: memberId, content: 'top-level' },
    });
    topId = top.id;
    const reply = await prisma.comment.create({
      data: { postId, authorId: memberId, parentId: topId, content: 'a reply' },
    });
    replyId = reply.id;
  });

  afterAll(async () => {
    await prisma.comment.deleteMany({ where: { postId } });
    await prisma.post.delete({ where: { id: postId } });
    await prisma.member.delete({ where: { id: memberId } });
    await prisma.$disconnect();
  });

  it('curates a top-level comment', async () => {
    const c = await commentService.setCurated(topId, true);
    expect(c.isCurated).toBe(true);
  });

  it('curates a reply (comment with parentId)', async () => {
    const c = await commentService.setCurated(replyId, true);
    expect(c.isCurated).toBe(true);
    expect(c.parentId).toBe(topId);
  });

  it('throws NotFoundException on unknown id', async () => {
    await expect(
      commentService.setCurated('00000000-0000-7000-8000-000000000000', true),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
