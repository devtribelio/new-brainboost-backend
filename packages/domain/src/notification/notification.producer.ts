import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import { ActionLabel, type NotifGroup } from './action-labels';
import { fcmService } from './fcm.service';

/** app_settings fallback. 0 = gate off (the counter is still tracked). */
export const UNOPENED_PUSH_LIMIT_DEFAULT = 0;

// Transactional notifications always push and never charge the counter: a member
// who ignores three social pushes must still be told their payout landed. Same
// reasoning that keeps commerce out of the mute rules.
const PUSH_LIMIT_EXEMPT: ReadonlySet<string> = new Set<string>([
  ActionLabel.PaymentSuccess,
  ActionLabel.PaymentPending,
  ActionLabel.PaymentRefunded,
  ActionLabel.SubscriptionRenewed,
  ActionLabel.CommissionEarned,
]);

export interface CreateNotificationInput {
  memberId: string;
  type: ActionLabel;
  title: string;
  body?: string;
  networkId?: string | null;
  notifGroup?: NotifGroup;
  payload?: Record<string, unknown>;
  url?: string;
  dedupeKey?: string;
}

export class NotificationProducer {
  async createForMember(input: CreateNotificationInput) {
    const member = await prisma.member.findUnique({
      where: { id: input.memberId },
      select: { notificationsEnabled: true, isActive: true },
    });
    if (!member || !member.isActive || !member.notificationsEnabled) return null;

    // Pre-check dedupe so the common duplicate-event path doesn't hit the unique
    // constraint — that would make Prisma log a `prisma:error` for an expected skip.
    // The catch below still backstops the concurrent-insert race.
    if (input.dedupeKey) {
      const existing = await prisma.notification.findUnique({
        where: { dedupeKey: input.dedupeKey },
        select: { id: true },
      });
      if (existing) {
        logger.debug({ dedupeKey: input.dedupeKey }, '[notification] dedupe skip');
        return null;
      }
    }

    try {
      const row = await prisma.notification.create({
        data: {
          memberId: input.memberId,
          type: input.type,
          title: input.title,
          body: input.body,
          networkId: input.networkId ?? null,
          notifGroup: input.notifGroup,
          payload: input.payload ? (input.payload as object) : undefined,
          url: input.url,
          dedupeKey: input.dedupeKey,
        },
      });
      logger.info(
        { notificationId: row.id, memberId: input.memberId, type: input.type, networkId: input.networkId ?? undefined },
        '[notification] created',
      );
      this.dispatchPush(input, row.id);
      return row;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2002') {
        logger.debug({ dedupeKey: input.dedupeKey }, '[notification] dedupe skip');
        return null;
      }
      throw err;
    }
  }

  async createForMany(memberIds: string[], base: Omit<CreateNotificationInput, 'memberId' | 'dedupeKey'>, dedupePrefix?: string) {
    const results = await Promise.allSettled(
      memberIds.map((memberId) =>
        this.createForMember({
          ...base,
          memberId,
          dedupeKey: dedupePrefix ? `${dedupePrefix}:${memberId}` : undefined,
        }),
      ),
    );
    const created = results.filter((r) => r.status === 'fulfilled' && r.value !== null).length;
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) logger.warn({ failed, total: memberIds.length }, '[notification] some creates failed');
    return { created, failed, total: memberIds.length };
  }

  /**
   * Charge one push against the member's unopened-push budget.
   *
   * The increment is what makes this safe under concurrency: two notifications
   * landing at once both read their own post-increment value, so exactly one of
   * them can be the one that crosses the limit. Reading-then-writing would let
   * both see the same count and both send.
   *
   * Exempt types return early WITHOUT incrementing. With the limit at 0 the
   * counter still moves (so the real distribution can be measured from logs)
   * but nothing is ever suppressed.
   */
  async claimPushSlot(memberId: string, type: ActionLabel): Promise<{ allowed: boolean; count: number }> {
    if (PUSH_LIMIT_EXEMPT.has(type)) return { allowed: true, count: 0 };

    const [limit, member] = await Promise.all([
      settingsService.getNumber(
        SETTING_KEYS.notificationUnopenedPushLimit,
        UNOPENED_PUSH_LIMIT_DEFAULT,
      ),
      prisma.member.update({
        where: { id: memberId },
        data: { unopenedPushCount: { increment: 1 } },
        select: { unopenedPushCount: true },
      }),
    ]);

    const count = member.unopenedPushCount;
    return { allowed: limit <= 0 || count <= limit, count };
  }

  private dispatchPush(input: CreateNotificationInput, notificationId: string): void {
    if (!fcmService.isEnabled()) {
      logger.debug({ notificationId }, '[notification] push skipped — fcm disabled');
      return;
    }
    setImmediate(async () => {
      const slot = await this.claimPushSlot(input.memberId, input.type).catch((err) => {
        // Never let the budget check swallow a push — fail open.
        logger.warn({ err, notificationId }, '[notification] unopened-push check failed');
        return { allowed: true, count: -1 };
      });
      if (!slot.allowed) {
        logger.info(
          { notificationId, memberId: input.memberId, type: input.type, unopenedPushCount: slot.count },
          '[notification] push suppressed — member has not opened the app',
        );
        return;
      }

      logger.info(
        { notificationId, memberId: input.memberId, type: input.type, unopenedPushCount: slot.count },
        '[notification] push firing',
      );
      const data: Record<string, string> = {
        type: input.type,
        notificationId,
      };
      if (input.networkId) data.networkId = input.networkId;
      if (input.payload) {
        for (const [k, v] of Object.entries(input.payload)) {
          if (v == null) continue;
          data[k] = typeof v === 'string' ? v : JSON.stringify(v);
        }
      }
      fcmService
        .sendToMember(input.memberId, { title: input.title, body: input.body, data })
        .catch((err) => logger.warn({ err, notificationId }, '[notification] fcm dispatch failed'));
    });
  }
}
