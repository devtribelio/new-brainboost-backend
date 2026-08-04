import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';

/**
 * Re-arm the unopened-push budget on ANY authenticated member request.
 *
 * /member/info was the original re-arm point, but the app only calls it on COLD
 * START — a member who keeps resuming from background never re-arms and goes
 * permanently silent once the limit is hit, which is the exact opposite of what
 * the limit is for. Any authenticated request at all is far better proof that a
 * human is holding the phone.
 *
 * Deliberately does NOT touch `lastActiveAt`. The dormant re-KYC trigger
 * (`MemberService.findById`) needs that column to still hold the PREVIOUS
 * session's timestamp when /member/info runs — that gap IS the idle span.
 * Refreshing it per request would collapse the gap to zero and silently disable
 * dormant re-KYC. Same reason `lastActiveAt` cannot be used as the freshness
 * signal here: it is written by the same cold-start-only endpoint.
 */

const THROTTLE_MS = 60_000;
// Bounded so a long-lived process can't accumulate one entry per member seen.
// Dropping the whole map only costs one extra conditional UPDATE per member.
const MAX_TRACKED = 10_000;

const lastTouch = new Map<string, number>();

export function resetUnopenedPushCount(memberId: string): void {
  const now = Date.now();
  const seen = lastTouch.get(memberId);
  if (seen !== undefined && now - seen < THROTTLE_MS) return;

  if (lastTouch.size >= MAX_TRACKED) lastTouch.clear();
  lastTouch.set(memberId, now);

  // Conditional: a member already at 0 matches no row, so the common case costs
  // nothing beyond the index probe. Fire-and-forget — request latency must never
  // depend on this.
  void prisma.member
    .updateMany({
      where: { id: memberId, unopenedPushCount: { gt: 0 } },
      data: { unopenedPushCount: 0 },
    })
    .catch((err) => logger.warn({ err, memberId }, '[notification] unopened-push re-arm failed'));
}

/** Test hook — drops the throttle window so specs don't leak state into each other. */
export function clearActivityThrottle(): void {
  lastTouch.clear();
}
