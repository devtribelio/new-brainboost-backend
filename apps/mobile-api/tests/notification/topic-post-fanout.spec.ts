import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { prisma } from '@bb/db';
import { notificationEvents } from '@bb/common/events/notification-events';
import { registerTopicNotificationListener } from '@bb/domain/notification/listeners/topic.listener';

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function makeMember(tag: string, notificationsEnabled = true): Promise<string> {
  const m = await prisma.member.create({
    data: {
      email: `topic-fanout-${tag}-${uid()}@test.local`,
      passwordHash: await bcrypt.hash('s', 4),
      notificationsEnabled,
    },
  });
  return m.id;
}

describe('post.published → topic subscriber fan-out', () => {
  let topicId = '';
  let otherTopicId = '';
  let authorId = '';
  let subscriberId = '';
  let disabledId = '';
  let mutedId = '';
  let memberIds: string[] = [];

  beforeAll(async () => {
    registerTopicNotificationListener();

    const topic = await prisma.topic.create({ data: { name: `Fanout Topic ${uid()}` } });
    topicId = topic.id;
    const other = await prisma.topic.create({ data: { name: `Other Topic ${uid()}` } });
    otherTopicId = other.id;

    authorId = await makeMember('author');
    subscriberId = await makeMember('sub');
    disabledId = await makeMember('disabled', false);
    mutedId = await makeMember('muted');
    memberIds = [authorId, subscriberId, disabledId, mutedId];

    // The author is subscribed too — the fan-out must still skip them.
    await prisma.topicSubscription.createMany({
      data: [authorId, subscriberId, disabledId, mutedId].map((memberId) => ({ memberId, topicId })),
    });
    await prisma.notificationMute.create({
      data: { memberId: mutedId, scope: 'topic', refId: topicId },
    });
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { memberId: { in: memberIds } } });
    await prisma.notificationMute.deleteMany({ where: { memberId: { in: memberIds } } });
    await prisma.topicSubscription.deleteMany({ where: { topicId: { in: [topicId, otherTopicId] } } });
    await prisma.member.deleteMany({ where: { id: { in: memberIds } } });
    await prisma.topic.deleteMany({ where: { id: { in: [topicId, otherTopicId] } } });
    await prisma.$disconnect();
  });

  it('notifies subscribers, but not the author, the opted-out, or the muted', async () => {
    const postId = randomUUID();
    notificationEvents.emit('post.published', {
      postId,
      authorId,
      topicId,
      networkId: null,
      excerpt: 'isi postingan',
    });
    await wait(200);

    const rows = await prisma.notification.findMany({
      where: { memberId: { in: memberIds }, type: 'newPost' },
    });
    expect(rows.map((r) => r.memberId)).toEqual([subscriberId]);

    const row = rows[0]!;
    expect(row.dedupeKey).toBe(`newPost:${postId}:${subscriberId}`);
    expect(row.body).toBe('isi postingan');
    expect(row.payload).toMatchObject({ refTable: 'post', refId: postId, topicId, actorId: authorId });
  });

  it('is idempotent — a re-emitted event creates no second row', async () => {
    const postId = randomUUID();
    const payload = {
      postId,
      authorId,
      topicId,
      networkId: null,
      excerpt: 'dua kali',
    };
    notificationEvents.emit('post.published', payload);
    await wait(200);
    notificationEvents.emit('post.published', payload);
    await wait(200);

    const rows = await prisma.notification.findMany({
      where: { dedupeKey: `newPost:${postId}:${subscriberId}` },
    });
    expect(rows).toHaveLength(1);
  });

  it('does nothing when the post has no topic', async () => {
    const postId = randomUUID();
    notificationEvents.emit('post.published', {
      postId,
      authorId,
      topicId: null,
      networkId: null,
      excerpt: 'tanpa topic',
    });
    await wait(200);

    const rows = await prisma.notification.findMany({
      where: { memberId: { in: memberIds }, payload: { path: ['refId'], equals: postId } },
    });
    expect(rows).toHaveLength(0);
  });

  it('does not leak across topics — a post in another topic reaches nobody here', async () => {
    const postId = randomUUID();
    notificationEvents.emit('post.published', {
      postId,
      authorId,
      topicId: otherTopicId,
      networkId: null,
      excerpt: 'topic lain',
    });
    await wait(200);

    const rows = await prisma.notification.findMany({
      where: { memberId: { in: memberIds }, payload: { path: ['refId'], equals: postId } },
    });
    expect(rows).toHaveLength(0);
  });
});
