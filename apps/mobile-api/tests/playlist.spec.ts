import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { prisma } from '@bb/db';
import { ERROR_CODES } from '@bb/common/exceptions';
import { SettingsService, settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import { PlaylistService } from '@/modules/playlist/playlist.service';

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

/**
 * A lesson slide carrying a Bunny audio. The slide id is what a playlist item
 * points at, so every fixture needs its own — sharing one would collide on
 * `(playlist_id, audio_id)`.
 */
function audioSlides(audioId: string, guid = `guid-${audioId}`) {
  return [{ id: audioId, type: 'AudioTemplate', data: { guid, durationSec: 600 } }];
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
  /** Slide ids — what playlist items reference. */
  const slides: string[] = [];
  let inactiveSlideId = '';

  beforeAll(async () => {
    const pw = await bcrypt.hash('s', 4);
    subscriber = (await prisma.member.create({ data: { email: `pl-sub-${uid()}@test.local`, passwordHash: pw } })).id;
    plain = (await prisma.member.create({ data: { email: `pl-plain-${uid()}@test.local`, passwordHash: pw } })).id;
    trialMember = (await prisma.member.create({ data: { email: `pl-trial-${uid()}@test.local`, passwordHash: pw } })).id;

    productId = (await prisma.product.create({ data: { type: 'course', title: 'Playlist Course', code: `PL-${uid()}` } })).id;
    courseId = (await prisma.course.create({ data: { productId, programDays: 30 } })).id;
    sectionId = (await prisma.courseSection.create({ data: { courseId, name: 'S1' } })).id;

    for (let i = 0; i < 3; i++) {
      const audioId = `slide-${uid()}`;
      await prisma.lesson.create({
        data: { sectionId, name: `Audio ${i + 1}`, duration: 600, slidesData: audioSlides(audioId) },
      });
      slides.push(audioId);
    }
    inactiveSlideId = `slide-${uid()}`;
    await prisma.lesson.create({
      data: {
        sectionId,
        name: 'Archived',
        duration: 60,
        lessonStatus: 'ARCHIVED',
        slidesData: audioSlides(inactiveSlideId),
      },
    });

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
    await prisma.listeningSession.deleteMany({ where: { memberId: { in: members } } });
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
      const res = await service.create(subscriber, { name: 'With items', audioIds: [slides[0], slides[1]] });
      expect(res.added).toBe(2);
      const detail = await service.detail(res.playlist.id, subscriber);
      expect(detail.items.map((i) => i.audioId)).toEqual([slides[0], slides[1]]);
    });

    it('treats a duplicate as a no-op, not an error, and skips inactive lessons', async () => {
      const { playlist } = await service.create(subscriber, { name: 'Dup', audioIds: [slides[0]] });
      const res = await service.addItems(subscriber, playlist.id, [slides[0], slides[1], inactiveSlideId]);
      expect(res).toMatchObject({ added: 1, alreadyPresent: 1 });
      expect(res.skipped).toEqual([inactiveSlideId]);
    });

    it('refuses to go past the item limit', async () => {
      await setSetting(SETTING_KEYS.playlistMaxItems, '2');
      const { playlist } = await service.create(subscriber, { name: 'Cap' });
      await service.addItems(subscriber, playlist.id, [slides[0], slides[1]]);
      await expect(service.addItems(subscriber, playlist.id, [slides[2]])).rejects.toMatchObject({
        code: ERROR_CODES.PLAYLIST_ITEM_LIMIT_EXCEEDED,
      });
      await setSetting(SETTING_KEYS.playlistMaxItems, '200');
    });

    it('rewrites the whole order from the final array', async () => {
      const { playlist } = await service.create(subscriber, { name: 'Order', audioIds: slides });
      await service.reorder(subscriber, playlist.id, [slides[2], slides[0], slides[1]]);
      const detail = await service.detail(playlist.id, subscriber);
      expect(detail.items.map((i) => i.audioId)).toEqual([slides[2], slides[0], slides[1]]);
    });

    it("refuses to touch someone else's playlist", async () => {
      const { playlist } = await service.create(subscriber, { name: 'Mine' });
      await setSetting(SETTING_KEYS.playlistRequiresSubscription, 'false');
      await expect(service.addItems(plain, playlist.id, [slides[0]])).rejects.toMatchObject({
        code: ERROR_CODES.PLAYLIST_FORBIDDEN,
      });
    });
  });

  describe('detail', () => {
    it('names each item after the product, not the lesson', async () => {
      // Product decision 2026-08-25: items of the same course therefore read alike.
      const { playlist } = await service.create(subscriber, { name: 'Naming', audioIds: [slides[0], slides[1]] });
      const detail = await service.detail(playlist.id, subscriber);
      expect(detail.items.map((i) => i.name)).toEqual(['Playlist Course', 'Playlist Course']);
    });

    it('carries the course artwork and code on every item, locked or not', async () => {
      await prisma.product.update({
        where: { id: productId },
        data: { thumbnail: 'https://cdn.test/cover.jpg', code: 'plcode1' },
      });
      const { playlist } = await service.create(subscriber, { name: 'Art', audioIds: [slides[0]] });
      const detail = await service.detail(playlist.id, subscriber);
      expect(detail.items[0].coverUrl).toBe('https://cdn.test/cover.jpg');
      expect(detail.items[0].courseCode).toBe('plcode1');
    });

    it("falls back to the first item's artwork when the playlist has no cover", async () => {
      await prisma.product.update({
        where: { id: productId },
        data: { thumbnail: 'https://cdn.test/cover.jpg' },
      });
      const { playlist } = await service.create(subscriber, { name: 'No cover', audioIds: [slides[0]] });

      // Detail: derived, and never written back to the row.
      const detail = await service.detail(playlist.id, subscriber);
      expect(detail.coverUrl).toBe('https://cdn.test/cover.jpg');
      expect((await prisma.playlist.findUnique({ where: { id: playlist.id } }))?.coverUrl).toBeNull();

      // List: same fallback, so no grey placeholder on the playlist tab either.
      const listed = (await service.listMine(subscriber)).find((r) => r.id === playlist.id);
      expect(listed?.coverUrl).toBe('https://cdn.test/cover.jpg');
    });

    it('keeps an explicit playlist cover over the derived one', async () => {
      const { playlist } = await service.create(subscriber, {
        name: 'Own cover',
        coverUrl: 'https://cdn.test/mine.jpg',
        audioIds: [slides[0]],
      });
      expect((await service.detail(playlist.id, subscriber)).coverUrl).toBe('https://cdn.test/mine.jpg');
    });

    it('reports up to four DISTINCT covers, in order of first appearance', async () => {
      // Second course so the playlist spans two artworks.
      const p2 = await prisma.product.create({
        data: { type: 'course', title: 'Second Course', code: `PL2-${uid()}`, thumbnail: 'https://cdn.test/b.jpg' },
      });
      const c2 = await prisma.course.create({ data: { productId: p2.id, programDays: 30 } });
      const s2 = await prisma.courseSection.create({ data: { courseId: c2.id, name: 'S2' } });
      const otherSlide = `slide-${uid()}`;
      await prisma.lesson.create({
        data: { sectionId: s2.id, name: 'Other', duration: 300, slidesData: audioSlides(otherSlide) },
      });
      await prisma.product.update({ where: { id: productId }, data: { thumbnail: 'https://cdn.test/a.jpg' } });

      try {
        // slides[0] and slides[1] share one course — its art must appear ONCE.
        const { playlist } = await service.create(subscriber, {
          name: 'Mosaic',
          audioIds: [slides[0], slides[1], otherSlide],
        });

        const detail = await service.detail(playlist.id, subscriber);
        expect(detail.coverUrls).toEqual(['https://cdn.test/a.jpg', 'https://cdn.test/b.jpg']);
        expect(detail.coverUrl).toBe('https://cdn.test/a.jpg');

        // The list derives the same shape, without returning items[].
        const listed = (await service.listMine(subscriber)).find((r) => r.id === playlist.id);
        expect(listed?.coverUrls).toEqual(['https://cdn.test/a.jpg', 'https://cdn.test/b.jpg']);
      } finally {
        await prisma.playlist.deleteMany({ where: { ownerId: subscriber } });
        await prisma.lesson.deleteMany({ where: { sectionId: s2.id } });
        await prisma.courseSection.delete({ where: { id: s2.id } });
        await prisma.course.delete({ where: { id: c2.id } });
        await prisma.product.delete({ where: { id: p2.id } });
      }
    });

    it('gives an empty playlist no covers at all', async () => {
      const { playlist } = await service.create(subscriber, { name: 'Kosong' });
      const detail = await service.detail(playlist.id, subscriber);
      expect(detail.coverUrls).toEqual([]);
      expect(detail.coverUrl).toBeNull();
    });

    it('unlocks every item for a subscriber and mints a stream url', async () => {
      const { playlist } = await service.create(subscriber, { name: 'Play', audioIds: slides });
      const detail = await service.detail(playlist.id, subscriber);
      expect(detail.totalItems).toBe(3);
      expect(detail.lockedItems).toBe(0);
      expect(detail.items[0].streamUrl).toContain('/api/member/media/stream?t=');
    });

    it('does NOT write a lazy course_enrollment while browsing', async () => {
      const { playlist } = await service.create(subscriber, { name: 'Browse', audioIds: slides });
      await prisma.courseEnrollment.deleteMany({ where: { memberId: subscriber, courseId } });
      await service.detail(playlist.id, subscriber);
      const rows = await prisma.courseEnrollment.count({ where: { memberId: subscriber, courseId } });
      expect(rows).toBe(0);
    });

    it('locks items the viewer cannot play once the gate is open to everyone', async () => {
      await setSetting(SETTING_KEYS.playlistRequiresSubscription, 'false');
      const { playlist } = await service.create(plain, { name: 'Locked', audioIds: slides });
      const detail = await service.detail(playlist.id, plain);
      expect(detail.lockedItems).toBe(3);
      expect(detail.items.every((i) => i.streamUrl === null)).toBe(true);
    });

    it('unlocks a live trial via activeEnrollment(), not OWNED_FOR_PURCHASE', async () => {
      await setSetting(SETTING_KEYS.playlistRequiresSubscription, 'false');
      const { playlist } = await service.create(trialMember, { name: 'Trial view', audioIds: [slides[0]] });
      const detail = await service.detail(playlist.id, trialMember);
      expect(detail.lockedItems).toBe(0);
      expect(detail.items[0].streamUrl).toContain('/api/member/media/stream?t=');
    });

    it('emits an interlude url only when the setting carries a guid', async () => {
      const { playlist } = await service.create(subscriber, { name: 'Interlude', audioIds: [slides[0]] });
      const off = await service.detail(playlist.id, subscriber);
      expect(off.interludeStreamUrl).toBeNull();
      expect(off.interludeAudioId).toBeNull();

      await setSetting(SETTING_KEYS.playlistInterludeAssetId, 'interlude-guid-1');
      const withInterlude = await service.detail(playlist.id, subscriber);
      expect(withInterlude.interludeStreamUrl).toContain('/api/member/media/stream?t=');
      // The app never sees the guid, so it gets a sentinel id to report instead.
      expect(withInterlude.interludeAudioId).toBe('__interlude__');
    });
  });

  describe('share + copy', () => {
    async function sharedPlaylist(name = 'Dibagikan') {
      const { playlist } = await service.create(subscriber, { name, audioIds: [slides[0], slides[1]] });
      const { shareToken } = await service.share(subscriber, playlist.id);
      return { playlist, token: shareToken };
    }

    it('mints one token and keeps returning it until asked to rotate', async () => {
      const { playlist, token } = await sharedPlaylist();
      const again = await service.share(subscriber, playlist.id);
      expect(again.shareToken).toBe(token);

      const rotated = await service.share(subscriber, playlist.id, true);
      expect(rotated.shareToken).not.toBe(token);
      // The old link dies the moment it is rotated.
      await expect(service.detailByShareToken(token)).rejects.toMatchObject({
        code: ERROR_CODES.PLAYLIST_NOT_FOUND,
      });
    });

    it('refuses to share an empty playlist', async () => {
      const { playlist } = await service.create(subscriber, { name: 'Kosong' });
      await expect(service.share(subscriber, playlist.id)).rejects.toMatchObject({
        code: ERROR_CODES.PLAYLIST_ITEMS_REQUIRED,
      });
    });

    it('answers an anonymous caller — metadata visible, every audio locked', async () => {
      const { token } = await sharedPlaylist();
      const view = await service.detailByShareToken(token);
      expect(view.totalItems).toBe(2);
      expect(view.lockedItems).toBe(2);
      expect(view.items.every((i) => i.streamUrl === null)).toBe(true);
      expect(view.canSave).toBe(false);
    });

    it('keeps a preview lesson playable for anyone', async () => {
      const previewSlideId = `slide-${uid()}`;
      const previewLesson = await prisma.lesson.create({
        data: {
          sectionId,
          name: 'Preview',
          duration: 120,
          isPreview: true,
          slidesData: audioSlides(previewSlideId),
        },
      });
      try {
        const { playlist } = await service.create(subscriber, { name: 'Preview mix', audioIds: [previewSlideId] });
        const { shareToken } = await service.share(subscriber, playlist.id);
        const view = await service.detailByShareToken(shareToken);
        expect(view.lockedItems).toBe(0);
        expect(view.items[0].streamUrl).toContain('/api/member/media/stream?t=');
      } finally {
        await prisma.playlistItem.deleteMany({ where: { lessonId: previewLesson.id } });
        await prisma.lesson.delete({ where: { id: previewLesson.id } });
      }
    });

    it('unlocks the audio for a subscriber who opens the link', async () => {
      const { token } = await sharedPlaylist();
      const view = await service.detailByShareToken(token, subscriber);
      expect(view.lockedItems).toBe(0);
      expect(view.isOwner).toBe(true);
    });

    it('goes 404 once the owner withdraws the link', async () => {
      const { playlist, token } = await sharedPlaylist();
      await service.unshare(subscriber, playlist.id);
      await expect(service.detailByShareToken(token)).rejects.toMatchObject({
        code: ERROR_CODES.PLAYLIST_NOT_FOUND,
      });
      const row = await prisma.playlist.findUnique({ where: { id: playlist.id } });
      expect(row?.visibility).toBe('PRIVATE');
    });

    it('goes 404 — not 403 — when ops blocks it, so the link cannot confirm it exists', async () => {
      const { playlist, token } = await sharedPlaylist();
      await prisma.playlist.update({ where: { id: playlist.id }, data: { isBlocked: true } });
      await expect(service.detailByShareToken(token)).rejects.toMatchObject({
        code: ERROR_CODES.PLAYLIST_NOT_FOUND,
      });
    });

    it('copies every item as is, locked ones included', async () => {
      const { token } = await sharedPlaylist();
      // Grant the copier a subscription seat so they may write at all.
      await prisma.subscriptionSeat.create({ data: { subscriptionId, memberId: plain, seatNo: 2 } });
      try {
        const { playlist: copy, created } = await service.saveFromShare(plain, token);
        expect(created).toBe(true);
        expect(copy.ownerId).toBe(plain);
        expect(copy.copiedFromToken).toBe(token);
        expect(copy.shareToken).toBeNull();

        const items = await prisma.playlistItem.count({ where: { playlistId: copy.id } });
        expect(items).toBe(2);
      } finally {
        await prisma.subscriptionSeat.deleteMany({ where: { subscriptionId, memberId: plain } });
      }
    });

    it('returns the same copy when save is tapped twice', async () => {
      const { token } = await sharedPlaylist();
      await prisma.subscriptionSeat.create({ data: { subscriptionId, memberId: plain, seatNo: 2 } });
      try {
        const first = await service.saveFromShare(plain, token);
        const second = await service.saveFromShare(plain, token);
        expect(second.created).toBe(false);
        expect(second.playlist.id).toBe(first.playlist.id);
      } finally {
        await prisma.subscriptionSeat.deleteMany({ where: { subscriptionId, memberId: plain } });
      }
    });

    it('refuses to save for a member without a subscription', async () => {
      const { token } = await sharedPlaylist();
      await expect(service.saveFromShare(plain, token)).rejects.toMatchObject({
        code: ERROR_CODES.PLAYLIST_SUBSCRIPTION_REQUIRED,
      });
      const view = await service.detailByShareToken(token, plain);
      // The link still opens for them — that is the whole point — but the button
      // becomes "subscribe to save".
      expect(view.canSave).toBe(false);
      expect(view.isSaved).toBe(false);
    });

    it('survives the source being deleted — a copy is not a reference', async () => {
      const { playlist, token } = await sharedPlaylist();
      await prisma.subscriptionSeat.create({ data: { subscriptionId, memberId: plain, seatNo: 2 } });
      try {
        const { playlist: copy } = await service.saveFromShare(plain, token);
        await prisma.playlist.delete({ where: { id: playlist.id } });
        const detail = await service.detail(copy.id, plain);
        expect(detail.totalItems).toBe(2);
      } finally {
        await prisma.subscriptionSeat.deleteMany({ where: { subscriptionId, memberId: plain } });
      }
    });
  });

  describe('history — recent + top', () => {
    /** One listening row, as the tracker would have written it. */
    async function play(playlistId: string, listenedSec: number, minutesAgo: number) {
      const startedAt = new Date(Date.now() - minutesAgo * 60 * 1000);
      await prisma.listeningSession.create({
        data: {
          memberId: subscriber,
          clientSessionId: randomUUID(),
          audioId: slides[0],
          playlistId,
          startedAt,
          listenedSec,
          completed: false,
          localDay: new Date(startedAt.toISOString().slice(0, 10)),
        },
      });
    }

    async function twoPlayed() {
      const a = (await service.create(subscriber, { name: 'A', audioIds: [slides[0]] })).playlist;
      const b = (await service.create(subscriber, { name: 'B', audioIds: [slides[1]] })).playlist;
      await play(a.id, 3600, 5);   // long, older
      await play(b.id, 120, 1);    // short, newer
      return { a, b };
    }

    afterEach(async () => {
      await prisma.listeningSession.deleteMany({ where: { memberId: subscriber } });
    });

    it('orders recent by last play and top by seconds listened', async () => {
      const { a, b } = await twoPlayed();

      const recent = await service.listRecent(subscriber);
      expect(recent.map((r) => r.playlist.id)).toEqual([b.id, a.id]);

      const top = await service.listTop(subscriber);
      expect(top.map((r) => r.playlist.id)).toEqual([a.id, b.id]);
      expect(top[0].totalListenedSec).toBe(3600);
    });

    it('carries the mosaic covers, same shape as scope=mine', async () => {
      // A history card renders a grey tile without this: `playlists.cover_url` is
      // never set (no UI for it), so the artwork can only come from the items.
      await prisma.product.update({
        where: { id: productId },
        data: { thumbnail: 'https://cdn.test/hist.jpg' },
      });
      const { playlist } = await service.create(subscriber, {
        name: 'Bersampul',
        audioIds: [slides[0]],
      });
      await play(playlist.id, 600, 1);

      for (const rows of [await service.listRecent(subscriber), await service.listTop(subscriber)]) {
        expect(rows[0].playlist.coverUrls).toEqual(['https://cdn.test/hist.jpg']);
        expect(rows[0].playlist.coverUrl).toBe('https://cdn.test/hist.jpg');
      }
    });

    it('ignores a mis-tap below the 30-second floor', async () => {
      const { playlist } = await service.create(subscriber, { name: 'Salah tap', audioIds: [slides[0]] });
      await play(playlist.id, 5, 1);
      expect(await service.listRecent(subscriber)).toEqual([]);
    });

    it('keeps top inside its window', async () => {
      const { playlist } = await service.create(subscriber, { name: 'Lama', audioIds: [slides[0]] });
      await play(playlist.id, 1800, 60 * 24 * 40); // 40 days ago
      expect(await service.listTop(subscriber, 30)).toEqual([]);
      expect((await service.listTop(subscriber, 60)).map((r) => r.playlist.id)).toEqual([playlist.id]);
    });

    it('drops a playlist that was deleted — silently, no tombstone row', async () => {
      const { playlist } = await service.create(subscriber, { name: 'Hilang', audioIds: [slides[0]] });
      await play(playlist.id, 600, 1);
      await prisma.playlist.delete({ where: { id: playlist.id } });
      expect(await service.listRecent(subscriber)).toEqual([]);
    });

    it("drops someone else's playlist once its link is withdrawn", async () => {
      const { playlist } = await service.create(subscriber, { name: 'Dicabut', audioIds: [slides[0]] });
      await service.share(subscriber, playlist.id);
      // Hand it to another owner so it is no longer "mine", only "shared".
      await prisma.playlist.update({ where: { id: playlist.id }, data: { ownerId: plain } });
      await play(playlist.id, 600, 1);

      expect((await service.listRecent(subscriber)).map((r) => r.playlist.id)).toEqual([playlist.id]);

      await prisma.playlist.update({
        where: { id: playlist.id },
        data: { shareToken: null, sharedAt: null },
      });
      expect(await service.listRecent(subscriber)).toEqual([]);
    });

    it('ignores standalone listening that came from no playlist', async () => {
      await prisma.listeningSession.create({
        data: {
          memberId: subscriber,
          clientSessionId: randomUUID(),
          audioId: slides[0],
          startedAt: new Date(),
          listenedSec: 1200,
          completed: true,
          localDay: new Date(new Date().toISOString().slice(0, 10)),
        },
      });
      expect(await service.listRecent(subscriber)).toEqual([]);
    });
  });
});
