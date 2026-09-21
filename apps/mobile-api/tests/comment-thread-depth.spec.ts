import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { CommentService } from '@bb/domain/comment/comment.service';
import { registerCommentNotificationListener } from '@bb/domain/notification/listeners/comment.listener';
import { serializeComment } from '@/modules/comment/comment.serializer';

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('comment thread depth', () => {
  const commentService = new CommentService();
  let authorId = '';
  let replierId = '';
  let postId = '';
  let topId = '';
  let replyId = '';
  let deepId = '';

  beforeAll(async () => {
    registerCommentNotificationListener();

    const [author, replier] = await Promise.all([
      prisma.member.create({
        data: { email: `thread-a-${uid()}@test.local`, passwordHash: await bcrypt.hash('s', 4) },
      }),
      prisma.member.create({
        data: { email: `thread-b-${uid()}@test.local`, passwordHash: await bcrypt.hash('s', 4) },
      }),
    ]);
    authorId = author.id;
    replierId = replier.id;

    const p = await prisma.post.create({
      data: { authorId, content: `host ${uid()}`, publishStatus: 'PUBLISHED' },
    });
    postId = p.id;

    const top = await prisma.comment.create({
      data: { postId, authorId, content: 'top-level' },
    });
    topId = top.id;
    const reply = await prisma.comment.create({
      data: { postId, authorId, parentId: topId, content: 'a reply' },
    });
    replyId = reply.id;
    // Written straight to the table: this is the shape the depth cap now refuses
    // to create, but rows like it already exist in production.
    const deep = await prisma.comment.create({
      data: { postId, authorId, parentId: replyId, content: 'a reply to a reply' },
    });
    deepId = deep.id;
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { memberId: { in: [authorId, replierId] } } });
    await prisma.commentLike.deleteMany({ where: { comment: { postId } } });
    await prisma.comment.deleteMany({ where: { postId, parentId: { not: null } } });
    await prisma.comment.deleteMany({ where: { postId } });
    await prisma.post.delete({ where: { id: postId } });
    await prisma.member.deleteMany({ where: { id: { in: [authorId, replierId] } } });
    await prisma.$disconnect();
  });

  it('keeps a reply to a top-level comment on that comment', async () => {
    const c = await commentService.create(replierId, {
      postId,
      content: 'replying to the top',
      parentId: topId,
    });
    expect(c.parentId).toBe(topId);
  });

  it('reparents a reply aimed at a reply onto the thread root', async () => {
    const c = await commentService.create(replierId, {
      postId,
      content: 'aimed at a reply',
      parentId: replyId,
    });
    expect(c.parentId).toBe(topId);
  });

  it('reparents onto the root even when the target is already at depth 3', async () => {
    const c = await commentService.create(replierId, {
      postId,
      content: 'aimed at a depth-3 row',
      parentId: deepId,
    });
    expect(c.parentId).toBe(topId);
  });

  it('counts a reparented reply on the root, not on the comment it was aimed at', async () => {
    const [root, aimed] = await Promise.all([
      prisma.comment.findUnique({ where: { id: topId }, select: { countReplies: true } }),
      prisma.comment.findUnique({ where: { id: replyId }, select: { countReplies: true } }),
    ]);
    expect(root?.countReplies).toBeGreaterThanOrEqual(3);
    expect(aimed?.countReplies).toBe(0);
  });

  it('detail() reports no root for a top-level comment', async () => {
    const c = await commentService.detail(topId);
    expect(c.rootId).toBeNull();
    expect(serializeComment(c).rootCommentId).toBeNull();
  });

  it('detail() reports the root for a reply', async () => {
    const c = await commentService.detail(replyId);
    expect(c.rootId).toBe(topId);
    expect(serializeComment(c).rootCommentId).toBe(topId);
  });

  it('detail() walks past an intermediate reply for a depth-3 row', async () => {
    const c = await commentService.detail(deepId);
    // `parentId` alone would open the wrong thread — it points at another reply.
    expect(c.parentId).toBe(replyId);
    expect(c.rootId).toBe(topId);
  });

  it('serializes rootCommentId as parentId when the service did not resolve one', async () => {
    const row = await prisma.comment.findUniqueOrThrow({ where: { id: replyId } });
    expect(serializeComment(row).rootCommentId).toBe(topId);
  });

  it('puts postId on a comment.liked notification so it can be routed', async () => {
    await commentService.toggleLike(replierId, replyId);
    await wait(200);

    const row = await prisma.notification.findUnique({
      where: { dedupeKey: `newLike:comment:${replyId}:${replierId}` },
    });
    expect(row).not.toBeNull();
    const payload = row?.payload as Record<string, unknown>;
    expect(payload.refTable).toBe('comment');
    expect(payload.refId).toBe(replyId);
    expect(payload.postId).toBe(postId);
    expect(payload.parentId).toBe(topId);
  });
});
