import { prisma } from '@bb/db';
import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import { logger } from '@bb/common/config/logger';
import { toLocalDayWIB } from './tracker.time';
import type { TrackSessionDto } from './dto/track-session.dto';

export class TrackingService {
  /**
   * The playlist interlude must never be counted as listening.
   *
   * `audioId` is a free string with no FK and no validation against `Lesson` —
   * deliberately, so the ingest log cannot fail because a lesson row was removed.
   * That leaves the "interlude is not listening time" guarantee resting entirely
   * on client discipline, and one player bug would quietly make the 10-minute
   * streak threshold a lie for every member. The interlude is a single global
   * asset whose id the server already knows, so dropping it here costs nothing
   * and moves the guarantee server-side (docs/playlist-port.md §3).
   */
  private async isInterlude(audioId: string): Promise<boolean> {
    const guid = (await settingsService.get(SETTING_KEYS.playlistInterludeAssetId, '')).trim();
    return guid !== '' && audioId === guid;
  }

  /**
   * Idempotent upsert of a listening session, keyed by (memberId, clientSessionId).
   * A re-send of the same session (pause→resume→complete, or offline-queue flush)
   * updates `listenedSec`/`completed` instead of inserting a duplicate row.
   * `localDay` is derived from `startedAt` in WIB at write time (spec §5.1).
   */
  async record(memberId: string, dto: TrackSessionDto, source: string | null): Promise<void> {
    if (await this.isInterlude(dto.audioId)) {
      logger.debug({ memberId, audioId: dto.audioId }, 'tracking.interlude_dropped');
      return;
    }
    const startedAt = new Date(dto.startedAt);
    const localDay = toLocalDayWIB(startedAt);

    await prisma.listeningSession.upsert({
      where: {
        memberId_clientSessionId: { memberId, clientSessionId: dto.clientSessionId },
      },
      create: {
        memberId,
        clientSessionId: dto.clientSessionId,
        audioId: dto.audioId,
        courseId: dto.courseId ?? null,
        playlistId: dto.playlistId ?? null,
        startedAt,
        listenedSec: dto.listenedSec,
        completed: dto.completed,
        localDay,
        source,
      },
      update: {
        // Original startedAt / localDay are kept; only progress fields move forward.
        listenedSec: dto.listenedSec,
        completed: dto.completed,
        source,
      },
    });
  }
}
