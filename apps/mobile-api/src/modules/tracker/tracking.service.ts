import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { badRequest, ERROR_CODES } from '@bb/common/exceptions';
import { MAX_CLOCK_SKEW_SEC, STALE_FLUSH_WARN_HOURS } from './tracker.constants';
import { toListeningDayWIB } from './tracker.time';
import type { TrackSessionDto } from './dto/track-session.dto';

export class TrackingService {
  /**
   * Idempotent upsert of a listening session, keyed by (memberId, clientSessionId).
   * A re-send of the same session (pause→resume→complete, heartbeat checkpoint, or
   * offline-queue flush) updates `listenedSec`/`completed` instead of inserting a
   * duplicate row.
   *
   * `listenedSec` is an ABSOLUTE cumulative total for the session, not a delta —
   * the update overwrites it. A client that ticks deltas would store the last tick
   * and lose the whole session.
   *
   * `localDay` is the listening day (04:00 WIB boundary) derived from `startedAt`
   * at write time, and is deliberately NOT recomputed on update: a late flush of a
   * session that started last night must still land on last night.
   */
  async record(memberId: string, dto: TrackSessionDto, source: string | null): Promise<void> {
    const startedAt = new Date(dto.startedAt);
    const now = Date.now();
    const aheadSec = (startedAt.getTime() - now) / 1000;

    // A future start can only come from a wrong device clock, and it lands the
    // session on a day the streak walk (backward from today) will never reach.
    if (aheadSec > MAX_CLOCK_SKEW_SEC) {
      throw badRequest(ERROR_CODES.TRACKING_STARTED_AT_IN_FUTURE, { aheadSec: Math.round(aheadSec) });
    }

    const behindHours = (now - startedAt.getTime()) / 3_600_000;
    if (behindHours > STALE_FLUSH_WARN_HOURS) {
      // Accepted, not rejected — this is real listening arriving late.
      logger.warn(
        { memberId, clientSessionId: dto.clientSessionId, behindHours: Math.round(behindHours) },
        'tracking.stale_flush',
      );
    }

    const localDay = toListeningDayWIB(startedAt);

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
