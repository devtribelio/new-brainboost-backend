import { Prisma } from '@prisma/client';
import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { enqueueComms } from '@bb/common/services/comms-outbox';
import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import { NotificationProducer } from '../notification/notification.producer';
import { ActionLabel, NotifGroup } from '../notification/action-labels';

const REMINDER_BUCKETS_DEFAULT = '7,3,1';
const producer = new NotificationProducer();

/**
 * Background job (PRD BE-15): H-7/H-3/H-1 renewal reminders for ACTIVE subs
 * (email via the comms outbox + in-app/push notification).
 *
 * Buckets come from app_settings subscription.reminderDaysBefore and are
 * processed SMALLEST FIRST: a sub first seen at H-1 gets exactly one reminder
 * (the H-1 one), not the whole ladder — bucket D only fires when no log row
 * with daysBefore <= D exists for (sub, expiresAt).
 *
 * Dedupe is INSERT-FIRST on subscription_reminder_logs (unique sub+expiresAt+
 * daysBefore): claim the row, then send — at-most-once per bucket per cycle.
 * Because expiresAt is part of the key, a renewal (which moves expiresAt)
 * automatically re-arms the next cycle's reminders. No cleanup needed.
 *
 * ⚠️ Do NOT enable on prod before the bb-comms SubscriptionRenewalReminder
 * template exists (outbox rows would fail at bb-comms). See tracker.
 */
export async function subscriptionRenewalReminder(
  now: Date = new Date(),
): Promise<{ sent: number; deduped: number }> {
  const rawBuckets = await settingsService.get(
    SETTING_KEYS.subscriptionReminderDaysBefore,
    REMINDER_BUCKETS_DEFAULT,
  );
  const buckets = rawBuckets
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b); // smallest first — see doc above

  let sent = 0;
  let deduped = 0;

  for (const daysBefore of buckets) {
    const windowEnd = new Date(now.getTime() + daysBefore * 24 * 3600 * 1000);
    const candidates = await prisma.memberSubscription.findMany({
      where: { status: 'ACTIVE', expiresAt: { gt: now, lte: windowEnd } },
      include: { plan: true },
    });

    for (const sub of candidates) {
      // Smaller-or-equal bucket already covered THIS expiry cycle → skip. Must be
      // scoped by (sub, expiresAt) — a log from the PREVIOUS cycle must not
      // suppress the re-armed cycle, and Prisma can't correlate log.expiresAt to
      // the parent row inside a relation filter, hence the per-sub check.
      const covered = await prisma.subscriptionReminderLog.count({
        where: {
          subscriptionId: sub.id,
          expiresAt: sub.expiresAt,
          daysBefore: { lte: daysBefore },
        },
      });
      if (covered > 0) {
        deduped++;
        continue;
      }

      // Claim first (unique sub+expiresAt+daysBefore) — the send below happens
      // at most once even across concurrent runs.
      try {
        await prisma.subscriptionReminderLog.create({
          data: { subscriptionId: sub.id, expiresAt: sub.expiresAt, daysBefore },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          deduped++;
          continue;
        }
        throw e;
      }

      try {
        await enqueueComms({
          type: 'SubscriptionRenewalReminder',
          channel: 'email',
          refId: sub.id, // bb-comms reads member_subscriptions (+plan+owner) by this id
        });
        await producer.createForMember({
          memberId: sub.ownerId,
          type: ActionLabel.SubscriptionReminder,
          notifGroup: NotifGroup.General,
          title: 'Langganan segera berakhir',
          body: `Langganan ${sub.plan.tier} kamu berakhir dalam ${daysBefore} hari. Perpanjang sekarang agar akses tidak terputus.`,
          payload: {
            refTable: 'member_subscriptions',
            refId: sub.id,
            planCode: sub.plan.code,
            expiresAt: sub.expiresAt.toISOString(),
            daysBefore,
          },
          dedupeKey: `subscriptionReminder:${sub.id}:${sub.expiresAt.toISOString()}:${daysBefore}`,
        });
        sent++;
      } catch (err) {
        // The log row stays claimed — we do NOT retry a half-sent bucket (the
        // email outbox insert is the first write; if IT failed, the next run
        // can't resend this bucket. Deliberate: over-silence beats spamming a
        // paying member; the H-3/H-1 buckets are the retry ladder.)
        logger.error(
          { err, subscriptionId: sub.id, daysBefore },
          '[subscription-reminder] send failed after claim',
        );
      }
    }
  }

  if (sent > 0 || deduped > 0) {
    logger.info({ sent, deduped, buckets }, '[subscription-reminder] cycle done');
  }
  return { sent, deduped };
}
