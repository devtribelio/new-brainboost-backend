import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { ERROR_CODES } from '@bb/common/exceptions';
import { SettingsService, settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import { PlaylistService } from '@/modules/playlist/playlist.service';

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

/** A lesson whose slides carry one Bunny audio — the only shape a playlist can play. */
function audioSlides(guid: string) {
  return [{ id: 's1', type: 'AudioTemplate', data: { guid, durationSec: 600 } }];
}

async function setSetting(key: string, value: string) {
  await settingsService.set(key, value);
  SettingsService.clearCache();
}

describe('PlaylistService (real Postgres)', () => {
  const service = new PlaylistService();

  let subscriber = '';
  let plain = '';
  let trialMember = '';
  let productId = '';
  let courseId = '';
  let sectionId = '';
  let planId = '';
  let subscriptionId = '';
  let voucherId = '';
  const lessons: string[] = [];
  let inactiveLessonId = '';

  beforeAll(async () => {
    const pw = await bcrypt.hash('s', 4);
    subscriber = (await prisma.member.create({ data: { email: `pl-sub-${uid()}@test.local`, passwordHash: pw } })).id;
    plain = (await prisma.member.create({ data: { email: `pl-plain-${uid()}@test.local`, passwordHash: pw } })).id;
    trialMember = (await prisma.member.create({ data: { email: `pl-trial-${uid()}@test.local`, passwordHash: pw } })).id;

    productId = (await prisma.product.create({ data: { type: 'course', title: 'Playlist Course', code: `PL-${uid()}` } })).id;
    courseId = (await prisma.course.create({ data: { productId, programDays: 30 } })).id;
    sectionId = (await prisma.courseSection.create({ data: { courseId, name: 'S1' } })).id;

    for (let i = 0; i < 3; i++) {
      const l = await prisma.lesson.create({
        data: { sectionId, name: `Audio ${i + 1}`, duration: 600, slidesData: audioSlides(`guid-${uid()}`) },
      });
      lessons.push(l.id);
    }
    inactiveLessonId = (await prisma.lesson.create({
      data: { sectionId, name: 'Archived', duration: 60, lessonStatus: 'ARCHIVED', slidesData: audioSlides(`guid-${uid()}`) },
    })).id;

    // Subscriber: an ACTIVE subscription that has not expired.
    const planProduct = await prisma.product.create({ data: { type: 'subscription', title: 'Solo', code: `SUB-${uid()}`, price: 999_000 } });
    planId = (await prisma.subscriptionPlan.create({
      data: {
        productId: planProduct.id,
        code: `solo-${uid()}`,
        tier: 'SOLO',
        seatCount: 1,
        periodMonths: 12,
        affiliateRate: 40,
        renewalAffiliateRate: 10,
      },
    })).id;
    subscriptionId = (await prisma.memberSubscription.create({
      data: {
        ownerId: subscriber,
        planId,
        status: 'ACTIVE',
        source: 'xendit',
        expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      },
    })).id;
    await prisma.subscriptionSeat.create({ data: { subscriptionId, memberId: subscriber, seatNo: 1 } });

    // Trial member: a live time-boxed enrollment via a TRIAL voucher, NO subscription.
    voucherId = (await prisma.voucher.create({
      data: { code: `TRIAL-${uid()}`, type: 'TRIAL', value: 0, trialDays: 7, quota: 10 },
    })).id;
    await prisma.courseEnrollment.create({
      data: {
        memberId: trialMember,
        courseId,
        viaVoucherId: voucherId,
        expiredDate: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        dateStart: new Date(),
      },
    });
  });

  afterAll(async () => {
    const members = [subscriber, plain, trialMember].filter(Boolean);
    if (members.length === 0) {
      await prisma.$disconnect();
      return;
    }
    await prisma.playlist.deleteMany({ where: { ownerId: { in: members } } });
    if (subscriptionId) await prisma.subscriptionSeat.deleteMany({ where: { subscriptionId } });
    if (subscriptionId) await prisma.memberSubscription.deleteMany({ where: { id: subscriptionId } });
    if (planId) await prisma.subscriptionPlan.deleteMany({ where: { id: planId } });
    if (courseId) await prisma.courseEnrollment.deleteMany({ where: { courseId } });
    if (voucherId) await prisma.voucher.deleteMany({ where: { id: voucherId } });
    if (sectionId) await prisma.lesson.deleteMany({ where: { sectionId } });
    if (sectionId) await prisma.courseSection.deleteMany({ where: { id: sectionId } });
    if (courseId) await prisma.course.deleteMany({ where: { id: courseId } });
    await prisma.product.deleteMany({ where: { OR: [{ id: productId }, { type: 'subscription', code: { startsWith: 'SUB-' } }] } });
    await prisma.member.deleteMany({ where: { id: { in: members } } });
    await prisma.appSetting.deleteMany({ where: { key: { startsWith: 'playlist.' } } });
    SettingsService.clearCache();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.playlist.deleteMany({ where: { ownerId: { in: [subscriber, plain, trialMember] } } });
    await prisma.member.updateMany({ where: { id: { in: [subscriber, plain, trialMember] } }, data: { playlistQuota: null } });
    await setSetting(SETTING_KEYS.playlistMaxPerMember, '20');
    await setSetting(SETTING_KEYS.playlistRequiresSubscription, 'true');
    await setSetting(SETTING_KEYS.playlistInterludeAssetId, '');
  });

  describe('subscription gate', () => {
    it('lets a subscriber create a playlist', async () => {
      const { playlist } = await service.create(subscriber, { name: 'Pagi Fokus' });
      expect(playlist.ownerId).toBe(subscriber);
      expect(playlist.visibility).toBe('PRIVATE');
    });

    it('rejects a member without a subscription', async () => {
      await expect(service.create(plain, { name: 'Nope' })).rejects.toMatchObject({
        code: ERROR_CODES.PLAYLIST_SUBSCRIPTION_REQUIRED,
      });
    });

    it('rejects a free-trial member — a trial is not a subscription', async () => {
      await expect(service.create(trialMember, { name: 'Trial' })).rejects.toMatchObject({
        code: ERROR_CODES.PLAYLIST_SUBSCRIPTION_REQUIRED,
      });
    });

    it('lets any member in once the kill-switch opens the feature', async () => {
      await setSetting(SETTING_KEYS.playlistRequiresSubscription, 'false');
      const { playlist } = await service.create(trialMember, { name: 'Open mode' });
      expect(playlist.ownerId).toBe(trialMember);
    });

    it('keeps existing playlists readable after the subscription lapses', async () => {
      const { playlist } = await service.create(subscriber, { name: 'Sisa' });
      await prisma.memberSubscription.update({
        where: { id: subscriptionId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      try {
        const rows = await service.listMine(subscriber);
        expect(rows.map((r) => r.id)).toContain(playlist.id);
        await expect(service.update(subscriber, playlist.id, { name: 'x' })).rejects.toMatchObject({
          code: ERROR_CODES.PLAYLIST_SUBSCRIPTION_REQUIRED,
        });
      } finally {
        await prisma.memberSubscription.update({
          where: { id: subscriptionId },
          data: { expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000) },
        });
      }
    });
  });

  describe('quota', () => {
    it('allows the last slot and refuses the one after it', async () => {
      await setSetting(SETTING_KEYS.playlistMaxPerMember, '2');
      await service.create(subscriber, { name: 'A' });
      await service.create(subscriber, { name: 'B' });
      await expect(service.create(subscriber, { name: 'C' })).rejects.toMatchObject({
        code: ERROR_CODES.PLAYLIST_QUOTA_EXCEEDED,
      });
    });

    it('lets a per-member override raise AND lower the global limit', async () => {
      await setSetting(SETTING_KEYS.playlistMaxPerMember, '1');
      await prisma.member.update({ where: { id: subscriber }, data: { playlistQuota: 2 } });
      await service.create(subscriber, { name: 'A' });
      await service.create(subscriber, { name: 'B' });
      await expect(service.create(subscriber, { name: 'C' })).rejects.toMatchObject({
        code: ERROR_CODES.PLAYLIST_QUOTA_EXCEEDED,
      });

      await setSetting(SETTING_KEYS.playlistMaxPerMember, '99');
      await prisma.member.update({ where: { id: subscriber }, data: { playlistQuota: 2 } });
      await expect(service.create(subscriber, { name: 'D' })).rejects.toMatchObject({
        code: ERROR_CODES.PLAYLIST_QUOTA_EXCEEDED,
      });
    });

    it('treats -1 as unlimited and 0 as a block (0 is NOT unlimited)', async () => {
      await prisma.member.update({ where: { id: subscriber }, data: { playlistQuota: 0 } });
      await expect(service.create(subscriber, { name: 'blocked' })).rejects.toMatchObject({
        code: ERROR_CODES.PLAYLIST_QUOTA_EXCEEDED,
      });

      await prisma.member.update({ where: { id: subscriber }, data: { playlistQuota: -1 } });
      await service.create(subscriber, { name: 'A' });
      await service.create(subscriber, { name: 'B' });
      const quota = await service.getQuota(subscriber);
      expect(quota.limit).toBeNull();
      expect(quota.remaining).toBeNull();
    });

    it('never deletes anything when the limit drops below what the member owns', async () => {
      await setSetting(SETTING_KEYS.playlistMaxPerMember, '3');
      await service.create(subscriber, { name: 'A' });
      await service.create(subscriber, { name: 'B' });
      await setSetting(SETTING_KEYS.playlistMaxPerMember, '1');

      const rows = await service.listMine(subscriber);
      expect(rows).toHaveLength(2);
      await expect(service.create(subscriber, { name: 'C' })).rejects.toMatchObject({
        code: ERROR_CODES.PLAYLIST_QUOTA_EXCEEDED,
      });
      // Tidying up must stay possible even while over the cap.
      await service.update(subscriber, rows[0].id, { name: 'renamed' });
      await service.remove(subscriber, rows[1].id);
    });
  });

  describe('items', () => {
    it('creates with the first items in one call', async () => {
      const res = await service.create(subscriber, { name: 'With items', lessonIds: [lessons[0], lessons[1]] });
      expect(res.added).toBe(2);
      const detail = await service.detail(res.playlist.id, subscriber);
      expect(detail.items.map((i) => i.lessonId)).toEqual([lessons[0], lessons[1]]);
    });

    it('treats a duplicate as a no-op, not an error, and skips inactive lessons', async () => {
      const { playlist } = await service.create(subscriber, { name: 'Dup', lessonIds: [lessons[0]] });
      const res = await service.addItems(subscriber, playlist.id, [lessons[0], lessons[1], inactiveLessonId]);
      expect(res).toMatchObject({ added: 1, alreadyPresent: 1 });
      expect(res.skipped).toEqual([inactiveLessonId]);
    });

    it('refuses to go past the item limit', async () => {
      await setSetting(SETTING_KEYS.playlistMaxItems, '2');
      const { playlist } = await service.create(subscriber, { name: 'Cap' });
      await service.addItems(subscriber, playlist.id, [lessons[0], lessons[1]]);
      await expect(service.addItems(subscriber, playlist.id, [lessons[2]])).rejects.toMatchObject({
        code: ERROR_CODES.PLAYLIST_ITEM_LIMIT_EXCEEDED,
      });
      await setSetting(SETTING_KEYS.playlistMaxItems, '200');
    });

    it('rewrites the whole order from the final array', async () => {
      const { playlist } = await service.create(subscriber, { name: 'Order', lessonIds: lessons });
      await service.reorder(subscriber, playlist.id, [lessons[2], lessons[0], lessons[1]]);
      const detail = await service.detail(playlist.id, subscriber);
      expect(detail.items.map((i) => i.lessonId)).toEqual([lessons[2], lessons[0], lessons[1]]);
    });

    it("refuses to touch someone else's playlist", async () => {
      const { playlist } = await service.create(subscriber, { name: 'Mine' });
      await setSetting(SETTING_KEYS.playlistRequiresSubscription, 'false');
      await expect(service.addItems(plain, playlist.id, [lessons[0]])).rejects.toMatchObject({
        code: ERROR_CODES.PLAYLIST_FORBIDDEN,
      });
    });
  });

  describe('detail', () => {
    it('unlocks every item for a subscriber and mints a stream url', async () => {
      const { playlist } = await service.create(subscriber, { name: 'Play', lessonIds: lessons });
      const detail = await service.detail(playlist.id, subscriber);
      expect(detail.totalItems).toBe(3);
      expect(detail.lockedItems).toBe(0);
      expect(detail.items[0].streamUrl).toContain('/api/member/media/stream?t=');
    });

    it('does NOT write a lazy course_enrollment while browsing', async () => {
      const { playlist } = await service.create(subscriber, { name: 'Browse', lessonIds: lessons });
      await prisma.courseEnrollment.deleteMany({ where: { memberId: subscriber, courseId } });
      await service.detail(playlist.id, subscriber);
      const rows = await prisma.courseEnrollment.count({ where: { memberId: subscriber, courseId } });
      expect(rows).toBe(0);
    });

    it('locks items the viewer cannot play once the gate is open to everyone', async () => {
      await setSetting(SETTING_KEYS.playlistRequiresSubscription, 'false');
      const { playlist } = await service.create(plain, { name: 'Locked', lessonIds: lessons });
      const detail = await service.detail(playlist.id, plain);
      expect(detail.lockedItems).toBe(3);
      expect(detail.items.every((i) => i.streamUrl === null)).toBe(true);
    });

    it('unlocks a live trial via activeEnrollment(), not OWNED_FOR_PURCHASE', async () => {
      await setSetting(SETTING_KEYS.playlistRequiresSubscription, 'false');
      const { playlist } = await service.create(trialMember, { name: 'Trial view', lessonIds: [lessons[0]] });
      const detail = await service.detail(playlist.id, trialMember);
      expect(detail.lockedItems).toBe(0);
      expect(detail.items[0].streamUrl).toContain('/api/member/media/stream?t=');
    });

    it('emits an interlude url only when the setting carries a guid', async () => {
      const { playlist } = await service.create(subscriber, { name: 'Interlude', lessonIds: [lessons[0]] });
      expect((await service.detail(playlist.id, subscriber)).interludeStreamUrl).toBeNull();

      await setSetting(SETTING_KEYS.playlistInterludeAssetId, 'interlude-guid-1');
      expect((await service.detail(playlist.id, subscriber)).interludeStreamUrl).toContain(
        '/api/member/media/stream?t=',
      );
    });
  });
});
