import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { settingsService, SETTING_KEYS, SettingsService } from '@bb/common/services/settings.service';
import {
  collectDigests,
  topicDigest,
  wibHour,
  joinTopicNames,
} from '@bb/domain/jobs/topic-digest';

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

/**
 * Digest reads UNREAD `newPost` rows, so the fixtures are notification rows —
 * the posts themselves are irrelevant to the sweep.
 */
describe('topicDigest', () => {
  let memberId = '';
  let otherMemberId = '';
  let topicA = '';
  let topicB = '';
  let topicC = '';
  let memberIds: string[] = [];
  let topicIds: string[] = [];

  async function makeMember(tag: string): Promise<string> {
    const m = await prisma.member.create({
      data: { email: `digest-${tag}-${uid()}@test.local`, passwordHash: await bcrypt.hash('s', 4) },
    });
    return m.id;
  }

  async function addUnread(member: string, topic: string, count: number, readAt: Date | null = null) {
    for (let i = 0; i < count; i++) {
      await prisma.notification.create({
        data: {
          memberId: member,
          type: 'newPost',
          topicId: topic,
          title: 'x',
          readAt,
          dedupeKey: `digest-${uid()}`,
        },
      });
    }
  }

  function digestFor(plan: Awaited<ReturnType<typeof collectDigests>>, member: string) {
    return plan.pushes.find((p) => p.memberId === member);
  }

  beforeAll(async () => {
    memberId = await makeMember('main');
    otherMemberId = await makeMember('other');
    memberIds = [memberId, otherMemberId];

    const [a, b, c] = await Promise.all([
      prisma.topic.create({ data: { name: `Mindset ${uid()}` } }),
      prisma.topic.create({ data: { name: `Bisnis ${uid()}` } }),
      prisma.topic.create({ data: { name: `Sehat ${uid()}` } }),
    ]);
    topicA = a.id;
    topicB = b.id;
    topicC = c.id;
    topicIds = [topicA, topicB, topicC];
  });

  beforeEach(async () => {
    await prisma.notification.deleteMany({ where: { memberId: { in: memberIds } } });
    await prisma.notificationMute.deleteMany({ where: { memberId: { in: memberIds } } });
    await prisma.member.updateMany({
      where: { id: { in: memberIds } },
      data: { lastTopicDigestAt: null },
    });
    SettingsService.clearCache();
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { memberId: { in: memberIds } } });
    await prisma.notificationMute.deleteMany({ where: { memberId: { in: memberIds } } });
    await prisma.member.deleteMany({ where: { id: { in: memberIds } } });
    await prisma.topic.deleteMany({ where: { id: { in: topicIds } } });
    await prisma.appSetting.deleteMany({
      where: {
        key: { in: [SETTING_KEYS.notificationDigestEnabled, SETTING_KEYS.notificationDigestHour] },
      },
    });
    SettingsService.clearCache();
    await prisma.$disconnect();
  });

  describe('copy helpers', () => {
    it('names the topic when there is only one', () => {
      expect(joinTopicNames(['Mindset'])).toBe('Mindset');
    });

    it('joins two with "dan"', () => {
      expect(joinTopicNames(['Mindset', 'Bisnis'])).toBe('Mindset dan Bisnis');
    });

    it('summarises the tail beyond two', () => {
      expect(joinTopicNames(['Mindset', 'Bisnis', 'Sehat', 'Karier'])).toBe(
        'Mindset, Bisnis, dan 2 topik lain',
      );
    });

    it('reads the hour in WIB, not UTC', () => {
      // 2026-08-04T14:00Z = 21:00 WIB
      expect(wibHour(new Date('2026-08-04T14:00:00.000Z'))).toBe(21);
    });
  });

  describe('one topic', () => {
    it('names the topic in the body and keeps the topic deep link', async () => {
      await addUnread(memberId, topicA, 9);
      const plan = await collectDigests();
      const push = digestFor(plan, memberId)!;

      const name = (await prisma.topic.findUnique({ where: { id: topicA } }))!.name;
      expect(push.title).toBe(name);
      expect(push.body).toBe(`Ada 9 post baru di ${name}`);
      expect(push.data).toMatchObject({
        type: 'topicDigest',
        refTable: 'topic',
        refId: topicA,
        topicName: name,
        postCount: '9',
      });
    });
  });

  describe('several topics', () => {
    it('merges into one tribe push with no single target', async () => {
      await addUnread(memberId, topicA, 12);
      await addUnread(memberId, topicB, 3);
      await addUnread(memberId, topicC, 2);

      const push = digestFor(await collectDigests(), memberId)!;
      expect(push.title).toBe('Tribe');
      expect(push.body).toMatch(/^Ada 17 post baru di .+, .+, dan 1 topik lain$/);
      expect(push.data.type).toBe('tribeDigest');
      expect(push.data.topicCount).toBe('3');
      expect(push.data.postCount).toBe('17');
      expect(push.data.refTable).toBeUndefined();
    });

    it('orders topic names by how much activity each had', async () => {
      await addUnread(memberId, topicA, 2);
      await addUnread(memberId, topicB, 20);

      const push = digestFor(await collectDigests(), memberId)!;
      const bName = (await prisma.topic.findUnique({ where: { id: topicB } }))!.name;
      expect(push.body.startsWith(`Ada 22 post baru di ${bName}`)).toBe(true);
    });
  });

  describe('what is counted', () => {
    it('ignores rows the member already read', async () => {
      await addUnread(memberId, topicA, 4);
      await addUnread(memberId, topicA, 6, new Date());

      const push = digestFor(await collectDigests(), memberId)!;
      expect(push.data.postCount).toBe('4');
    });

    it('sends nothing to a member who read everything', async () => {
      await addUnread(memberId, topicA, 5, new Date());
      const plan = await collectDigests();
      expect(digestFor(plan, memberId)).toBeUndefined();
      expect(plan.candidates).not.toContain(memberId);
    });

    it('drops a muted topic before counting, and stays silent when all are muted', async () => {
      await addUnread(memberId, topicA, 9);
      await addUnread(memberId, topicB, 4);
      await prisma.notificationMute.create({
        data: { memberId, scope: 'topic', refId: topicA },
      });

      const plan = await collectDigests();
      const push = digestFor(plan, memberId)!;
      // Only topic B survives → single-topic shape, and 9 is NOT in the total.
      expect(push.data.refId).toBe(topicB);
      expect(push.data.postCount).toBe('4');

      await prisma.notificationMute.create({
        data: { memberId, scope: 'topic', refId: topicB },
      });
      const muted = await collectDigests();
      expect(digestFor(muted, memberId)).toBeUndefined();
      // Still a candidate: the watermark must move, or these rows recur nightly.
      expect(muted.candidates).toContain(memberId);
      expect(muted.silentAllMuted).toBeGreaterThanOrEqual(1);
    });

    it('keeps members separate', async () => {
      await addUnread(memberId, topicA, 3);
      await addUnread(otherMemberId, topicB, 7);

      const plan = await collectDigests();
      expect(digestFor(plan, memberId)!.data.postCount).toBe('3');
      expect(digestFor(plan, otherMemberId)!.data.postCount).toBe('7');
    });

    it('ignores notifications with no topic', async () => {
      await prisma.notification.create({
        data: { memberId, type: 'newLike', title: 'x', dedupeKey: `digest-${uid()}` },
      });
      const plan = await collectDigests();
      expect(digestFor(plan, memberId)).toBeUndefined();
    });
  });

  describe('scheduling', () => {
    it('does nothing while disabled', async () => {
      await settingsService.set(SETTING_KEYS.notificationDigestEnabled, 'false');
      SettingsService.clearCache();
      await addUnread(memberId, topicA, 3);

      const result = await topicDigest(new Date('2026-08-04T14:00:00.000Z'));
      expect(result.skipped).toBe('disabled');
    });

    it('does nothing outside the configured hour', async () => {
      await settingsService.set(SETTING_KEYS.notificationDigestEnabled, 'true');
      await settingsService.set(SETTING_KEYS.notificationDigestHour, '21');
      SettingsService.clearCache();
      await addUnread(memberId, topicA, 3);

      // 08:00 WIB
      const result = await topicDigest(new Date('2026-08-04T01:00:00.000Z'));
      expect(result.skipped).toBe('wrong-hour');
    });

    it('runs at the configured hour and moves the watermark', async () => {
      await settingsService.set(SETTING_KEYS.notificationDigestEnabled, 'true');
      await settingsService.set(SETTING_KEYS.notificationDigestHour, '21');
      SettingsService.clearCache();
      await addUnread(memberId, topicA, 3);

      const runAt = new Date('2026-08-04T14:00:00.000Z');
      const result = await topicDigest(runAt);
      expect(result.skipped).toBeUndefined();
      expect(result.candidates).toBeGreaterThanOrEqual(1);

      const m = await prisma.member.findUnique({
        where: { id: memberId },
        select: { lastTopicDigestAt: true },
      });
      expect(m!.lastTopicDigestAt?.getTime()).toBe(runAt.getTime());
    });

    it('does not report the same posts twice on the next run', async () => {
      await settingsService.set(SETTING_KEYS.notificationDigestEnabled, 'true');
      await settingsService.set(SETTING_KEYS.notificationDigestHour, '21');
      SettingsService.clearCache();
      await addUnread(memberId, topicA, 3);

      await topicDigest(new Date('2026-08-04T14:00:00.000Z'));
      // Same unread rows, one day later — already accounted for by the watermark.
      const second = await collectDigests();
      expect(digestFor(second, memberId)).toBeUndefined();
    });

    // Options exist only for the manual trigger (`pnpm digest:run`), which has to
    // work outside the one scheduled hour with the setting shipping `false`.
    describe('manual trigger options', () => {
      it('force runs while disabled and outside the hour', async () => {
        await settingsService.set(SETTING_KEYS.notificationDigestEnabled, 'false');
        SettingsService.clearCache();
        await addUnread(memberId, topicA, 3);

        // 08:00 WIB, digest hour is 21 — both gates would normally stop this.
        const result = await topicDigest(new Date('2026-08-04T01:00:00.000Z'), { force: true });
        expect(result.skipped).toBeUndefined();
        expect(result.candidates).toBeGreaterThanOrEqual(1);
      });

      // The stamp is the destructive half: it marks these posts as reported, so a
      // preview that moved it would silently rob the night's real digest.
      it('dry run previews without sending or moving the watermark', async () => {
        await addUnread(memberId, topicA, 3);

        const result = await topicDigest(new Date('2026-08-04T01:00:00.000Z'), {
          force: true,
          dryRun: true,
        });
        expect(result.pushed).toBe(0);
        expect(result.preview?.some((p) => p.memberId === memberId)).toBe(true);

        const m = await prisma.member.findUnique({
          where: { id: memberId },
          select: { lastTopicDigestAt: true },
        });
        expect(m!.lastTopicDigestAt).toBeNull();
      });

      it('memberId confines the sweep to that one member', async () => {
        await addUnread(memberId, topicA, 3);
        await addUnread(otherMemberId, topicB, 2);

        const result = await topicDigest(new Date('2026-08-04T01:00:00.000Z'), {
          force: true,
          dryRun: true,
          memberId,
        });
        expect(result.candidates).toBe(1);
        expect(result.preview?.map((p) => p.memberId)).toEqual([memberId]);
      });

      it('a scoped real run leaves the other member unstamped', async () => {
        await addUnread(memberId, topicA, 3);
        await addUnread(otherMemberId, topicB, 2);

        await topicDigest(new Date('2026-08-04T01:00:00.000Z'), { force: true, memberId });

        const rows = await prisma.member.findMany({
          where: { id: { in: memberIds } },
          select: { id: true, lastTopicDigestAt: true },
        });
        expect(rows.find((r) => r.id === memberId)!.lastTopicDigestAt).not.toBeNull();
        expect(rows.find((r) => r.id === otherMemberId)!.lastTopicDigestAt).toBeNull();
      });
    });

    it('leaves the unopened-push budget alone', async () => {
      await settingsService.set(SETTING_KEYS.notificationDigestEnabled, 'true');
      await settingsService.set(SETTING_KEYS.notificationDigestHour, '21');
      SettingsService.clearCache();
      await prisma.member.update({ where: { id: memberId }, data: { unopenedPushCount: 7 } });
      await addUnread(memberId, topicA, 3);

      await topicDigest(new Date('2026-08-04T14:00:00.000Z'));

      const m = await prisma.member.findUnique({
        where: { id: memberId },
        select: { unopenedPushCount: true },
      });
      expect(m!.unopenedPushCount).toBe(7);
    });
  });
});
