import { prisma } from '@bb/db';
import { toLocalDayWIB } from './tracker.time';
import type { TrackSessionDto } from './dto/track-session.dto';

export class TrackingService {
  /**
   * Idempotent upsert of a listening session, keyed by (memberId, clientSessionId).
   * A re-send of the same session (pause→resume→complete, or offline-queue flush)
   * updates `listenedSec`/`completed` instead of inserting a duplicate row.
   * `localDay` is derived from `startedAt` in WIB at write time (spec §5.1).
   */
  async record(memberId: string, dto: TrackSessionDto, source: string | null): Promise<void> {
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
