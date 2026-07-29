import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { env } from '@bb/common/config/env';
import { PUSH_CHANNEL } from '@bb/common/mq/push-contract';
import { fcmService } from '@bb/domain/notification/fcm.service';
import {
  topicDigestNotifications,
  DIGEST_HOUR_WIB,
} from '@bb/domain/jobs/topic-digest-notifications';

/**
 * Queue mode: with a push queue configured the job must NOT call FCM itself —
 * it hands the push to the outbox so the relay/worker own delivery (and its
 * retries). The notification rows and the outbox row must commit together.
 */

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

function boundary(day: string): Date {
  return new Date(`${day}T${String(DIGEST_HOUR_WIB - 7).padStart(2, '0')}:00:00.000Z`);
}

const DAY = '2026-07-21';
const RUN_AT = new Date(boundary(DAY).getTime() + 60_000);

describe('topicDigestNotifications — SQS queue mode', () => {
  let subscriberId = '';
  let authorId = '';
  let topicId = '';
  let sendSpy: ReturnType<typeof vi.spyOn>;
  const originalQueueUrl = env.sqs.pushQueueUrl;

  beforeAll(async () => {
    env.sqs.pushQueueUrl = 'https://sqs.test.invalid/000000000000/notif-push';
    vi.spyOn(fcmService, 'isEnabled').mockReturnValue(true);
    sendSpy = vi.spyOn(fcmService, 'sendToMember').mockResolvedValue(undefined);

    const hash = await bcrypt.hash('s', 4);
    const [sub, author] = await Promise.all([
      prisma.member.create({ data: { email: `q-sub-${uid()}@test.local`, passwordHash: hash, fullName: 'Sub' } }),
      prisma.member.create({ data: { email: `q-auth-${uid()}@test.local`, passwordHash: hash, fullName: 'Author' } }),
    ]);
    subscriberId = sub.id;
    authorId = author.id;

    const topic = await prisma.topic.create({
      data: { name: `Queue Topic ${uid()}`, type: 'PUBLIC', isActive: true },
    });
    topicId = topic.id;
    await prisma.topicSubscription.create({ data: { memberId: subscriberId, topicId } });
  });

  afterAll(async () => {
    const memberIds = [subscriberId, authorId];
    await prisma.notificationOutbox.deleteMany({ where: { refId: { in: memberIds } } });
    await prisma.notification.deleteMany({ where: { memberId: { in: memberIds } } });
    await prisma.post.deleteMany({ where: { authorId: { in: memberIds } } });
    await prisma.topicSubscription.deleteMany({ where: { topicId } });
    await prisma.topic.delete({ where: { id: topicId } });
    await prisma.member.deleteMany({ where: { id: { in: memberIds } } });
    env.sqs.pushQueueUrl = originalQueueUrl;
    vi.restoreAllMocks();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    sendSpy.mockClear();
    await prisma.notificationOutbox.deleteMany({ where: { refId: { in: [subscriberId, authorId] } } });
    await prisma.notification.deleteMany({ where: { memberId: { in: [subscriberId, authorId] } } });
    await prisma.post.deleteMany({ where: { authorId: { in: [subscriberId, authorId] } } });
  });

  it('queues one outbox row instead of pushing in-process', async () => {
    for (let i = 0; i < 4; i += 1) {
      await prisma.post.create({
        data: {
          authorId,
          topicId,
          content: `p${i}`,
          excerpt: 'x',
          publishStatus: 'PUBLISHED',
          createdAt: new Date(boundary(DAY).getTime() - (i + 1) * 3_600_000),
        },
      });
    }

    const res = await topicDigestNotifications(RUN_AT, DIGEST_HOUR_WIB);

    expect(res.notifications).toBe(1);
    expect(sendSpy).not.toHaveBeenCalled();

    const outbox = await prisma.notificationOutbox.findMany({ where: { refId: subscriberId } });
    expect(outbox).toHaveLength(1);
    expect(outbox[0].channel).toBe(PUSH_CHANNEL);
    expect(outbox[0].status).toBe('PENDING');
    expect(outbox[0].type).toBe('topicDigest');

    const payload = outbox[0].payload as Record<string, unknown>;
    expect(payload.memberId).toBe(subscriberId);
    expect(payload.title).toMatch(/^4 post baru di Queue Topic/);
    expect((payload.data as Record<string, string>).totalPosts).toBe('4');

    // The feed row committed alongside it.
    expect(await prisma.notification.count({ where: { memberId: subscriberId } })).toBe(1);
  });

  it('does not queue a second time the same WIB day', async () => {
    await prisma.post.create({
      data: {
        authorId,
        topicId,
        content: 'p',
        excerpt: 'x',
        publishStatus: 'PUBLISHED',
        createdAt: new Date(boundary(DAY).getTime() - 3_600_000),
      },
    });

    await topicDigestNotifications(RUN_AT, DIGEST_HOUR_WIB);
    await topicDigestNotifications(new Date(RUN_AT.getTime() + 3_600_000), DIGEST_HOUR_WIB);

    expect(await prisma.notificationOutbox.count({ where: { refId: subscriberId } })).toBe(1);
    expect(await prisma.notification.count({ where: { memberId: subscriberId } })).toBe(1);
  });

  it('leaves nothing behind when the transaction fails', async () => {
    await prisma.post.create({
      data: {
        authorId,
        topicId,
        content: 'p',
        excerpt: 'x',
        publishStatus: 'PUBLISHED',
        createdAt: new Date(boundary(DAY).getTime() - 3_600_000),
      },
    });

    // Force the outbox insert to blow up -> the whole tx must roll back, so the
    // feed rows must not survive without their push job.
    const spy = vi
      .spyOn(prisma.notificationOutbox, 'create')
      .mockImplementation(() => {
        throw new Error('boom');
      });

    try {
      const res = await topicDigestNotifications(RUN_AT, DIGEST_HOUR_WIB);
      expect(res.notifications).toBe(0);
    } finally {
      spy.mockRestore();
    }

    expect(await prisma.notification.count({ where: { memberId: subscriberId } })).toBe(0);
    expect(await prisma.notificationOutbox.count({ where: { refId: subscriberId } })).toBe(0);
  });
});
