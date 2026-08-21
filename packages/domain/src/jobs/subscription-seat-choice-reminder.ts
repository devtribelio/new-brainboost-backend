import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import { NotificationProducer } from '../notification/notification.producer';
import { ActionLabel, NotifGroup } from '../notification/action-labels';

const REMINDER_BUCKETS_DEFAULT = '7,3,1';
const producer = new NotificationProducer();

/**
 * Background job: nudge an owner who has a scheduled downgrade but more
 * occupants than the smaller plan allows, and who has not said who keeps a seat.
 *
 * Silence here is expensive. If the owner never chooses, the fallback rule
 * decides for them (owner first, then lowest seat number) and somebody loses
 * access with no warning — so the reminder is what keeps the fallback from being
 * the normal path instead of the last resort.
 *
 * Sent only while there is a REAL decision to make:
 * - a pending change exists and lands within the bucket window,
 * - occupants exceed the incoming seat count,
 * - and no seat is marked yet. Choosing anything at all stops the nudges; the
 *   choice can still be revised right up to the effective date.
 *
 * Dedupe rides on the notification producer's `dedupeKey` rather than a log
 * table: the key carries the effective date and the bucket, so a re-declared or
 * re-dated change re-arms the ladder on its own. No new table, and nothing to
 * clean up when the change is cancelled — the query simply stops matching.
 *
 * In-app/push only, no email: this is a household-management chore, not a
 * billing event, and it points at a screen inside the app.
 */
export async function subscriptionSeatChoiceReminder(
  now: Date = new Date(),
): Promise<{ sent: number; skipped: number }> {
  const rawBuckets = await settingsService.get(
    SETTING_KEYS.subscriptionReminderDaysBefore,
    REMINDER_BUCKETS_DEFAULT,
  );
  const buckets = rawBuckets
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b); // smallest first, same ladder as the renewal reminder

  let sent = 0;
  let skipped = 0;
  const notified = new Set<string>();

  for (const daysBefore of buckets) {
    const windowEnd = new Date(now.getTime() + daysBefore * 24 * 3600 * 1000);
    const candidates = await prisma.memberSubscription.findMany({
      where: {
        status: 'ACTIVE',
        pendingPlanId: { not: null },
        pendingEffectiveAt: { gt: now, lte: windowEnd },
      },
      include: { plan: true, seats: true },
    });

    for (const sub of candidates) {
      // One nudge per sub per run: the smallest matching bucket wins, so a sub
      // first seen at H-1 is not also told H-3 and H-7 in the same cycle.
      if (notified.has(sub.id)) continue;

      const pendingPlan = await prisma.subscriptionPlan.findUnique({
        where: { id: sub.pendingPlanId as string },
      });
      if (!pendingPlan) continue;

      const claimed = sub.seats.filter((s) => s.memberId !== null).length;
      const alreadyChose = sub.seats.some((s) => s.pendingKeep);
      if (claimed <= pendingPlan.seatCount || alreadyChose) {
        skipped++;
        continue;
      }

      const effectiveAt = sub.pendingEffectiveAt ?? sub.expiresAt;
      try {
        await producer.createForMember({
          memberId: sub.ownerId,
          type: ActionLabel.SubscriptionChangeScheduled,
          notifGroup: NotifGroup.General,
          title: 'Pilih siapa yang tetap punya akses',
          body: `Paket kamu jadi ${pendingPlan.tier} (${pendingPlan.seatCount} seat) dalam ${daysBefore} hari, tapi sekarang ada ${claimed} anggota. Pilih sekarang, atau kami yang menentukan.`,
          payload: {
            refTable: 'member_subscriptions',
            refId: sub.id,
            planCode: sub.plan.code,
            pendingPlanCode: pendingPlan.code,
            effectiveAt: effectiveAt.toISOString(),
            daysBefore,
            mustEvict: true,
          },
          dedupeKey: `subscriptionSeatChoice:${sub.id}:${effectiveAt.toISOString()}:${daysBefore}`,
        });
        notified.add(sub.id);
        sent++;
      } catch (err) {
        logger.error(
          { err, subscriptionId: sub.id, daysBefore },
          '[seat-choice-reminder] send failed',
        );
      }
    }
  }

  if (sent > 0 || skipped > 0) {
    logger.info({ sent, skipped, buckets }, '[seat-choice-reminder] cycle done');
  }
  return { sent, skipped };
}
