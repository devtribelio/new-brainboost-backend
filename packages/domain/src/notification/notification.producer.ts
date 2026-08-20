import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import { toPlainText } from '@bb/common/utils/plain-text.util';
import { ActionLabel, type NotifGroup } from './action-labels';
import { fcmService } from './fcm.service';
import { RecipientResolver } from './recipient.resolver';
import type { MuteScope } from './mute-scope';

/** app_settings fallback. 0 = gate off (the counter is still tracked). */
export const UNOPENED_PUSH_LIMIT_DEFAULT = 0;

// Transactional notifications always push and never charge the counter: a member
// who ignores three social pushes must still be told their payout landed. Same
// reasoning that keeps commerce out of the mute rules.
const PUSH_LIMIT_EXEMPT: ReadonlySet<string> = new Set<string>([
  ActionLabel.PaymentSuccess,
  ActionLabel.TrialStarted,
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
  /** Denormalised so the nightly digest can group unread rows without reading `payload`. */
  topicId?: string | null;
  notifGroup?: NotifGroup;
  payload?: Record<string, unknown>;
  url?: string;
  dedupeKey?: string;
  /**
   * Objects this notification originates from — the post/topic/network a member
   * may have muted. A hit silences the PUSH only: the row is written either way,
   * unread like any other, so muting a busy topic costs the member their phone
   * buzzing, not the history of what happened while they were away.
   *
   * Pass the scopes here rather than filtering recipients upstream. Listeners
   * that dropped muted members used to delete the notification outright.
   */
  muteScopes?: Array<{ scope: MuteScope; refId: string }>;
}

export class NotificationProducer {
  private readonly resolver = new RecipientResolver();

  async createForMember(input: CreateNotificationInput) {
    const pushMuted = input.muteScopes?.length
      ? (await this.resolver.mutedMemberIds([input.memberId], input.muteScopes)).has(input.memberId)
      : false;
    return this.create(input, pushMuted);
  }

  // `pushMuted` is resolved by the caller so a fan-out pays one mute query for
  // the whole batch instead of one per member.
  private async create(input: CreateNotificationInput, pushMuted: boolean) {
    const member = await prisma.member.findUnique({
      where: { id: input.memberId },
      select: { notificationsEnabled: true, isActive: true },
    });
    if (!member || !member.isActive || !member.notificationsEnabled) return null;

    // Normalised here, at the one place every notification passes through, rather
    // than in each listener — a listener that forgot would ship `<p>p adu</p>` to
    // the lock screen. Post bodies come from `post.excerpt`, a raw slice of editor
    // HTML; titles interpolate member names, which are user-controlled too.
    // An empty result means the source was markup-only — store nothing, not ''.
    const display: CreateNotificationInput = {
      ...input,
      title: toPlainText(input.title),
      body: input.body ? toPlainText(input.body) || undefined : undefined,
    };

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
          title: display.title,
          body: display.body,
          networkId: input.networkId ?? null,
          topicId: input.topicId ?? null,
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
      this.dispatchPush(display, row.id, pushMuted);
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
    const muted = base.muteScopes?.length
      ? await this.resolver.mutedMemberIds(memberIds, base.muteScopes)
      : new Set<string>();

    const results = await Promise.allSettled(
      memberIds.map((memberId) =>
        this.create(
          {
            ...base,
            memberId,
            dedupeKey: dedupePrefix ? `${dedupePrefix}:${memberId}` : undefined,
          },
          muted.has(memberId),
        ),
      ),
    );
    const created = results.filter((r) => r.status === 'fulfilled' && r.value !== null).length;
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) logger.warn({ failed, total: memberIds.length }, '[notification] some creates failed');
    return { created, failed, pushMuted: muted.size, total: memberIds.length };
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

  /**
   * Push with NO notification row and NO budget charge — the digest's only path out.
   *
   * No row because the digest summarises rows that already exist; writing another
   * would duplicate the member's own history. Exempt from the unopened-push budget
   * on purpose: by digest time a member who ignored the app all day is already past
   * the limit, and the digest is exactly the message that member most needs. It is
   * capped at one per member per day by the job's own schedule, not by the budget.
   *
   * Awaited (not `setImmediate`) — a scheduled job must not exit before its sends land.
   */
  async sendPushOnly(
    memberId: string,
    payload: { title: string; body?: string; data: Record<string, string> },
  ): Promise<boolean> {
    if (!fcmService.isEnabled()) {
      logger.debug({ memberId }, '[notification] digest push skipped — fcm disabled');
      return false;
    }
    try {
      await fcmService.sendToMember(memberId, {
        title: toPlainText(payload.title),
        body: payload.body ? toPlainText(payload.body) || undefined : undefined,
        data: payload.data,
      });
      return true;
    } catch (err) {
      logger.warn({ err, memberId }, '[notification] digest push failed');
      return false;
    }
  }

  private dispatchPush(input: CreateNotificationInput, notificationId: string, pushMuted: boolean): void {
    // Checked before claimPushSlot on purpose: a push the member asked not to
    // receive must not spend their unopened-push budget, or muting one busy
    // topic would silence the topics they still care about.
    if (pushMuted) {
      logger.info(
        { notificationId, memberId: input.memberId, type: input.type },
        '[notification] push skipped — member muted this scope',
      );
      return;
    }
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
