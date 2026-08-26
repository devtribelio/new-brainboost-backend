import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { prisma } from '@bb/db';
import { SettingsService, settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import { TrackingService } from '@/modules/tracker/tracking.service';

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

const INTERLUDE_GUID = 'interlude-guid-under-test';

/**
 * The interlude must never reach `listening_session`: it would inflate the daily
 * total that the 10-minute streak threshold is measured against, silently, for
 * every member. `audioId` has no FK and is not validated against `Lesson`, so the
 * guard has to live in the ingest service — a client-side promise is not a guard.
 */
describe('TrackingService — interlude never counts as listening (real Postgres)', () => {
  const service = new TrackingService();
  let memberId = '';

  beforeAll(async () => {
    memberId = (await prisma.member.create({
      data: { email: `trk-${uid()}@test.local`, passwordHash: await bcrypt.hash('s', 4) },
    })).id;
    await settingsService.set(SETTING_KEYS.playlistInterludeAssetId, INTERLUDE_GUID);
    SettingsService.clearCache();
  });

  afterAll(async () => {
    await prisma.listeningSession.deleteMany({ where: { memberId } });
    await prisma.member.deleteMany({ where: { id: memberId } });
    await prisma.appSetting.deleteMany({ where: { key: SETTING_KEYS.playlistInterludeAssetId } });
    SettingsService.clearCache();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.listeningSession.deleteMany({ where: { memberId } });
  });

  function payload(audioId: string, playlistId?: string) {
    return {
      clientSessionId: randomUUID(),
      audioId,
      startedAt: new Date().toISOString(),
      listenedSec: 900,
      completed: true,
      ...(playlistId ? { playlistId } : {}),
    };
  }

  it('drops a session whose audioId is the configured interlude', async () => {
    await service.record(memberId, payload(INTERLUDE_GUID), 'ios');
    expect(await prisma.listeningSession.count({ where: { memberId } })).toBe(0);
  });

  it('still records ordinary audio, and keeps the playlist it was played from', async () => {
    const playlistId = randomUUID();
    await service.record(memberId, payload('lesson-audio-1', playlistId), 'ios');
    const row = await prisma.listeningSession.findFirst({ where: { memberId } });
    expect(row?.audioId).toBe('lesson-audio-1');
    expect(row?.playlistId).toBe(playlistId);
  });

  it('records everything when no interlude is configured', async () => {
    await settingsService.set(SETTING_KEYS.playlistInterludeAssetId, '');
    SettingsService.clearCache();
    try {
      await service.record(memberId, payload(INTERLUDE_GUID), 'ios');
      expect(await prisma.listeningSession.count({ where: { memberId } })).toBe(1);
    } finally {
      await settingsService.set(SETTING_KEYS.playlistInterludeAssetId, INTERLUDE_GUID);
      SettingsService.clearCache();
    }
  });
});
