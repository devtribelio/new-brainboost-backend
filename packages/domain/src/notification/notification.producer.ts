import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import type { ActionLabel, NotifGroup } from './action-labels';
import { fcmService } from './fcm.service';

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

  private dispatchPush(input: CreateNotificationInput, notificationId: string): void {
    if (!fcmService.isEnabled()) return;
    setImmediate(() => {
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
