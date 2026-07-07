import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { subscriptionEvents } from '@bb/common/events/subscription-events';

/**
 * Background job (PRD BE-16): flip subscriptions past their grace window
 * (coalesce(graceUntil, expiresAt) < now) from ACTIVE to EXPIRED and emit
 * subscription.expired. Lazy enrollments die on their own via expired_date —
 * no cleanup needed. Subs still inside grace are untouched.
 *
 * Idempotent per row (updateMany guarded on status=ACTIVE): a concurrent or
 * repeated run flips each sub exactly once, so the event fires exactly once.
 * Called from the jobs-runner (external scheduler).
 */
export async function subscriptionExpire(now: Date = new Date()): Promise<{ expired: number }> {
  const overdue = await prisma.memberSubscription.findMany({
    where: {
      status: 'ACTIVE',
      OR: [{ graceUntil: { lt: now } }, { graceUntil: null, expiresAt: { lt: now } }],
    },
    include: { plan: true },
  });

  let expired = 0;
  for (const sub of overdue) {
    try {
      const flipped = await prisma.memberSubscription.updateMany({
        where: { id: sub.id, status: 'ACTIVE' },
        data: { status: 'EXPIRED' },
      });
      if (flipped.count === 0) continue; // raced with another run/webhook — theirs

      subscriptionEvents.emit('subscription.expired', {
        subscriptionId: sub.id,
        ownerId: sub.ownerId,
        planId: sub.plan.id,
        planCode: sub.plan.code,
        tier: sub.plan.tier,
        expiresAt: sub.expiresAt,
        source: sub.source,
      });
      expired++;
    } catch (err) {
      logger.error({ err, subscriptionId: sub.id }, '[subscription-expire] failed to expire');
    }
  }

  if (expired > 0) {
    logger.info({ expired, scanned: overdue.length }, '[subscription-expire] swept expired subs');
  }
  return { expired };
}
