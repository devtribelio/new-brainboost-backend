import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { fcmService } from '@bb/domain/notification/fcm.service';
import {
  topicDigestNotifications,
  resolveDigestHour,
  DIGEST_HOUR_WIB,
} from '@bb/domain/jobs/topic-digest-notifications';
import { SettingsService, SETTING_KEYS } from '@bb/common/services/settings.service';

/**
 * Nightly 21:00 WIB topic recap. Real Postgres; the FCM transport is stubbed so
 * the assertion is "one combined push with the right copy", not "Google accepted it".
 *
 * Timestamps are pinned rather than relative: the whole point of the job is the
 * WIB day boundary, so the window edges have to be exercised exactly.
 */

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

/** 21:00 WIB on the given WIB calendar day, as a UTC instant. */
function boundary(day: string): Date {
  return new Date(`${day}T${String(DIGEST_HOUR_WIB - 7).padStart(2, '0')}:00:00.000Z`);
}

const DAY = '2026-07-20';
const RUN_AT = new Date(boundary(DAY).getTime() + 60_000); // 21:01 WIB

describe('topicDigestNotifications — 21:00 WIB recap', () => {
  let subscriberId = '';
  let quietId = '';
  let authorId = '';
  let topicAId = '';
  let topicBId = '';
  const pushes: Array<{ memberId: string; title: string; body?: string; data?: Record<string, string> }> = [];

  async function seedPost(topicId: string, at: Date, author = authorId) {
    return prisma.post.create({
      data: {
        authorId: author,
        topicId,
        content: `post ${uid()}`,
        excerpt: 'x',
        publishStatus: 'PUBLISHED',
        createdAt: at,
      },
    });
  }

  beforeAll(async () => {
    vi.spyOn(fcmService, 'isEnabled').mockReturnValue(true);
    vi.spyOn(fcmService, 'sendToMember').mockImplementation(async (memberId, payload) => {
      pushes.push({ memberId, ...payload });
    });

    const hash = await bcrypt.hash('s', 4);
    const [sub, quiet, author] = await Promise.all([
      prisma.member.create({ data: { email: `dig-sub-${uid()}@test.local`, passwordHash: hash, fullName: 'Sub' } }),
      prisma.member.create({ data: { email: `dig-quiet-${uid()}@test.local`, passwordHash: hash, fullName: 'Quiet' } }),
      prisma.member.create({ data: { email: `dig-auth-${uid()}@test.local`, passwordHash: hash, fullName: 'Author' } }),
    ]);
    subscriberId = sub.id;
    quietId = quiet.id;
    authorId = author.id;

    const [a, b] = await Promise.all([
      prisma.topic.create({ data: { name: `Topic A ${uid()}`, type: 'PUBLIC', isActive: true } }),
      prisma.topic.create({ data: { name: `Topic B ${uid()}`, type: 'PUBLIC', isActive: true } }),
    ]);
    topicAId = a.id;
    topicBId = b.id;

    await prisma.topicSubscription.createMany({
      data: [
        { memberId: subscriberId, topicId: topicAId },
        { memberId: subscriberId, topicId: topicBId },
        { memberId: quietId, topicId: topicAId },
      ],
    });
  });

  afterAll(async () => {
    const memberIds = [subscriberId, quietId, authorId];
    await prisma.notification.deleteMany({ where: { memberId: { in: memberIds } } });
    await prisma.notificationMute.deleteMany({ where: { memberId: { in: memberIds } } });
    await prisma.post.deleteMany({ where: { authorId: { in: memberIds } } });
    await prisma.topicSubscription.deleteMany({ where: { topicId: { in: [topicAId, topicBId] } } });
    await prisma.topic.deleteMany({ where: { id: { in: [topicAId, topicBId] } } });
    await prisma.member.deleteMany({ where: { id: { in: memberIds } } });
    vi.restoreAllMocks();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    pushes.length = 0;
    await prisma.notification.deleteMany({ where: { memberId: { in: [subscriberId, quietId, authorId] } } });
    await prisma.post.deleteMany({ where: { authorId: { in: [subscriberId, quietId, authorId] } } });
    await prisma.notificationMute.deleteMany({ where: { memberId: { in: [subscriberId, quietId, authorId] } } });
  });

  it('does nothing before 21:00 WIB', async () => {
    await seedPost(topicAId, new Date(boundary(DAY).getTime() - 3_600_000));

    const res = await topicDigestNotifications(
      new Date(boundary(DAY).getTime() - 60_000),
      DIGEST_HOUR_WIB,
    );

    expect(res.skipped).toBe('before-boundary');
    expect(pushes).toHaveLength(0);
    expect(await prisma.notification.count({ where: { memberId: subscriberId } })).toBe(0);
  });

  it('recaps a single topic as one row and one push', async () => {
    for (let i = 0; i < 9; i += 1) {
      await seedPost(topicAId, new Date(boundary(DAY).getTime() - (i + 1) * 3_600_000));
    }

    const res = await topicDigestNotifications(RUN_AT, DIGEST_HOUR_WIB);

    expect(res.posts).toBe(9);

    const rows = await prisma.notification.findMany({ where: { memberId: subscriberId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('topicDigest');
    expect(rows[0].title).toMatch(/^9 post baru di Topic A/);
    expect((rows[0].payload as Record<string, unknown>).postCount).toBe(9);

    const push = pushes.filter((p) => p.memberId === subscriberId);
    expect(push).toHaveLength(1);
    expect(push[0].title).toMatch(/^9 post baru di Topic A/);
    expect(push[0].data?.totalPosts).toBe('9');
  });

  it('sends ONE combined push when several topics have new posts', async () => {
    await seedPost(topicAId, new Date(boundary(DAY).getTime() - 3_600_000));
    await seedPost(topicAId, new Date(boundary(DAY).getTime() - 7_200_000));
    await seedPost(topicBId, new Date(boundary(DAY).getTime() - 3_600_000));

    await topicDigestNotifications(RUN_AT, DIGEST_HOUR_WIB);

    // Feed stays granular: one row per topic.
    const rows = await prisma.notification.findMany({ where: { memberId: subscriberId } });
    expect(rows).toHaveLength(2);

    // Push does not: exactly one, summarising both.
    const push = pushes.filter((p) => p.memberId === subscriberId);
    expect(push).toHaveLength(1);
    expect(push[0].title).toBe('3 post baru di 2 topic yang kamu ikuti');
    expect(push[0].data?.topicIds?.split(',')).toHaveLength(2);
  });

  it('is idempotent — a second run the same WIB day sends nothing', async () => {
    await seedPost(topicAId, new Date(boundary(DAY).getTime() - 3_600_000));

    await topicDigestNotifications(RUN_AT, DIGEST_HOUR_WIB);
    expect(pushes.filter((p) => p.memberId === subscriberId)).toHaveLength(1);

    pushes.length = 0;
    const second = await topicDigestNotifications(
      new Date(RUN_AT.getTime() + 3_600_000),
      DIGEST_HOUR_WIB,
    );

    expect(second.notifications).toBe(0);
    expect(pushes).toHaveLength(0);
    expect(await prisma.notification.count({ where: { memberId: subscriberId } })).toBe(1);
  });

  it('excludes posts outside the 24h window and the member’s own posts', async () => {
    await seedPost(topicAId, new Date(boundary(DAY).getTime() - 25 * 3_600_000)); // too old
    await seedPost(topicAId, new Date(boundary(DAY).getTime() + 60_000)); // after cutoff → tomorrow
    await seedPost(topicAId, new Date(boundary(DAY).getTime() - 3_600_000), subscriberId); // own post
    await seedPost(topicAId, new Date(boundary(DAY).getTime() - 3_600_000)); // the only one that counts

    await topicDigestNotifications(RUN_AT, DIGEST_HOUR_WIB);

    const rows = await prisma.notification.findMany({ where: { memberId: subscriberId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toMatch(/^1 post baru di Topic A/);

    // The author of the "own post" is the subscriber, so for the OTHER subscriber
    // both posts count.
    const quietRows = await prisma.notification.findMany({ where: { memberId: quietId } });
    expect(quietRows[0].title).toMatch(/^2 post baru di Topic A/);
  });

  it('takes the cutoff hour from app_settings', async () => {
    await prisma.appSetting.upsert({
      where: { key: SETTING_KEYS.notificationTopicDigestHour },
      create: { key: SETTING_KEYS.notificationTopicDigestHour, value: '18' },
      update: { value: '18' },
    });
    SettingsService.clearCache();

    try {
      expect(await resolveDigestHour()).toBe(18);

      await seedPost(topicAId, new Date(boundary(DAY).getTime() - 7_200_000)); // 19:00 WIB

      // 18:30 WIB — past the CONFIGURED cutoff, well before the 21:00 default.
      const at1830 = new Date(boundary(DAY).getTime() - 2 * 3_600_000 - 1_800_000);
      const res = await topicDigestNotifications(at1830);

      // The 19:00 post is after the 18:00 cutoff, so it belongs to tomorrow's
      // window — what matters here is that the job RAN instead of skipping.
      expect(res.skipped).toBeUndefined();
      expect(res.windowEnd?.toISOString()).toBe(
        new Date(boundary(DAY).getTime() - 3 * 3_600_000).toISOString(),
      );
    } finally {
      await prisma.appSetting.deleteMany({
        where: { key: SETTING_KEYS.notificationTopicDigestHour },
      });
      SettingsService.clearCache();
    }
  });

  it('falls back to the default when the setting is out of range', async () => {
    await prisma.appSetting.upsert({
      where: { key: SETTING_KEYS.notificationTopicDigestHour },
      create: { key: SETTING_KEYS.notificationTopicDigestHour, value: '99' },
      update: { value: '99' },
    });
    SettingsService.clearCache();

    try {
      expect(await resolveDigestHour()).toBe(DIGEST_HOUR_WIB);
    } finally {
      await prisma.appSetting.deleteMany({
        where: { key: SETTING_KEYS.notificationTopicDigestHour },
      });
      SettingsService.clearCache();
    }
  });

  it('honours a topic mute', async () => {
    await prisma.notificationMute.create({
      data: { memberId: subscriberId, scope: 'topic', refId: topicAId },
    });
    await seedPost(topicAId, new Date(boundary(DAY).getTime() - 3_600_000));

    await topicDigestNotifications(RUN_AT, DIGEST_HOUR_WIB);

    expect(await prisma.notification.count({ where: { memberId: subscriberId } })).toBe(0);
    expect(pushes.filter((p) => p.memberId === subscriberId)).toHaveLength(0);
    // The un-muted subscriber still gets it.
    expect(await prisma.notification.count({ where: { memberId: quietId } })).toBe(1);
  });
});
