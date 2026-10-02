import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import {
  moderatePost,
  MODERATION_MAX_ATTEMPTS,
  type ModerationOutcome,
} from '../moderation/post-moderation';
import { notifyTopicSubscribers } from '../notification/listeners/topic.listener';

// A PENDING row this old was not reached by the fire-and-forget check — the API
// process died or restarted between the response and the call. Well above the
// provider timeout, so a check still in flight is never raced.
const PENDING_STALE_MS = 2 * 60 * 1000;
// 5 at a time × a 20s timeout keeps a full batch far inside the 5-minute lane
// even with the provider down.
const BATCH_SIZE = 25;
const CONCURRENCY = 5;

/**
 * Safety net for post moderation (docs/tribe-moderation.md):
 *   - PENDING rows the inline check never got to → checked now;
 *   - ERROR rows (published fail-open) → re-checked, up to
 *     MODERATION_MAX_ATTEMPTS failed checks in total, then left alone.
 * Rows decided by an admin are never picked up.
 *
 * `postIds` scopes a run to specific posts (tests).
 */
export async function moderatePosts(
  now: Date = new Date(),
  opts: { postIds?: string[] } = {},
): Promise<Record<ModerationOutcome, number>> {
  const rows = await prisma.postModeration.findMany({
    where: {
      decidedBy: { not: 'ADMIN' },
      ...(opts.postIds ? { postId: { in: opts.postIds } } : {}),
      OR: [
        { status: 'PENDING', createdAt: { lt: new Date(now.getTime() - PENDING_STALE_MS) } },
        { status: 'ERROR', attempts: { lt: MODERATION_MAX_ATTEMPTS } },
      ],
    },
    orderBy: { updatedAt: 'asc' },
    take: BATCH_SIZE,
    select: { postId: true },
  });

  const counts: Record<ModerationOutcome, number> = { approved: 0, rejected: 0, error: 0, skipped: 0 };
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const outcomes = await Promise.all(
      rows
        .slice(i, i + CONCURRENCY)
        // Awaited fan-out: this process has no event listeners and exits when done.
        .map((r) => moderatePost(r.postId, { announce: notifyTopicSubscribers })),
    );
    for (const o of outcomes) counts[o] += 1;
  }
  if (rows.length > 0) logger.info(counts, '[jobs] moderatePosts done');
  return counts;
}
