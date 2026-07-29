import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { registerTopicNotificationListener } from '@bb/domain/notification/listeners/topic.listener';
import { fcmService } from '@bb/domain/notification/fcm.service';
import { TopicService } from '../../src/modules/topic/topic.service';
import { PostService } from '@bb/domain/post/post.service';

/**
 * A member who subscribes to a topic must receive the topic's new posts —
 * notification row AND FCM push. Real Postgres; the FCM transport is stubbed
 * so the assertion is "push was dispatched with the right payload", not
 * "Google accepted it".
 */

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const topics = new TopicService();
const posts = new PostService();

describe('post.published → topic subscriber notification + FCM', () => {
  let subscriberId = '';
  let outsiderId = '';
  let authorId = '';
  let topicId = '';
  const pushes: Array<{ memberId: string; title: string; body?: string; data?: Record<string, string> }> = [];

  beforeAll(async () => {
    registerTopicNotificationListener();

    // Force the push path on regardless of local FCM credentials, and capture
    // what would go over the wire.
    vi.spyOn(fcmService, 'isEnabled').mockReturnValue(true);
    vi.spyOn(fcmService, 'sendToMember').mockImplementation(async (memberId, payload) => {
      pushes.push({ memberId, ...payload });
    });

    const hash = await bcrypt.hash('s', 4);
    const [sub, outsider, author] = await Promise.all([
      prisma.member.create({ data: { email: `topic-sub-${uid()}@test.local`, passwordHash: hash, fullName: 'Subscriber' } }),
      prisma.member.create({ data: { email: `topic-out-${uid()}@test.local`, passwordHash: hash, fullName: 'Outsider' } }),
      prisma.member.create({ data: { email: `topic-auth-${uid()}@test.local`, passwordHash: hash, fullName: 'Budi Author' } }),
    ]);
    subscriberId = sub.id;
    outsiderId = outsider.id;
    authorId = author.id;

    const topic = await prisma.topic.create({
      data: { name: `Notif Topic ${uid()}`, type: 'PUBLIC', isActive: true },
    });
    topicId = topic.id;
  });

  afterAll(async () => {
    const memberIds = [subscriberId, outsiderId, authorId];
    await prisma.notification.deleteMany({ where: { memberId: { in: memberIds } } });
    await prisma.notificationMute.deleteMany({ where: { memberId: { in: memberIds } } });
    await prisma.post.deleteMany({ where: { authorId: { in: memberIds } } });
    await prisma.topicSubscription.deleteMany({ where: { topicId } });
    await prisma.topic.delete({ where: { id: topicId } });
    await prisma.member.deleteMany({ where: { id: { in: memberIds } } });
    vi.restoreAllMocks();
    await prisma.$disconnect();
  });

  it('delivers a newPost notification and FCM push to a subscriber', async () => {
    const res = await topics.subscribe(subscriberId, topicId);
    expect(res.status).toBe('APPROVED');

    await posts.create(authorId, { topicId, content: 'Materi baru sudah tayang' } as never);
    await wait(500);

    const notif = await prisma.notification.findFirst({ where: { memberId: subscriberId } });
    expect(notif).not.toBeNull();
    expect(notif!.type).toBe('newPost');
    expect(notif!.title).toContain('Budi Author');

    const push = pushes.find((p) => p.memberId === subscriberId);
    expect(push, 'FCM push was not dispatched to the subscriber').toBeTruthy();
    expect(push!.title).toContain('Budi Author');
    expect(push!.data?.topicId).toBe(topicId);
    expect(push!.data?.type).toBe('newPost');
  });

  it('does not notify a non-subscriber or the author', async () => {
    const outsiderNotifs = await prisma.notification.count({ where: { memberId: outsiderId } });
    expect(outsiderNotifs).toBe(0);
    const authorNotifs = await prisma.notification.count({ where: { memberId: authorId } });
    expect(authorNotifs).toBe(0);
  });

  it('honours a topic-scoped mute', async () => {
    pushes.length = 0;
    await prisma.notificationMute.create({
      data: { memberId: subscriberId, scope: 'topic', refId: topicId },
    });

    await posts.create(authorId, { topicId, content: 'Postingan kedua yang dibisukan' } as never);
    await wait(500);

    expect(pushes.find((p) => p.memberId === subscriberId)).toBeUndefined();
    const notifs = await prisma.notification.count({ where: { memberId: subscriberId } });
    expect(notifs).toBe(1);
  });
});
