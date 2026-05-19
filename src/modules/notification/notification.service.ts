import { prisma } from '@/config/prisma';
import type { PaginationParams } from '@/common/utils/pagination.util';

export type NotificationGroup = 'general' | 'creator' | 'all';

interface ListOptions {
  group?: NotificationGroup;
  isUnreadOnly?: boolean;
  isReadOnly?: boolean;
  networkId?: string;
}

const TIME_BUCKETS = ['today', 'thisWeek', 'thisMonth', 'earlier'] as const;
type TimeBucket = typeof TIME_BUCKETS[number];

function timeBucket(d: Date, now = new Date()): TimeBucket {
  const diffMs = now.getTime() - d.getTime();
  const day = 24 * 60 * 60 * 1000;
  if (diffMs < day) return 'today';
  if (diffMs < 7 * day) return 'thisWeek';
  if (diffMs < 30 * day) return 'thisMonth';
  return 'earlier';
}

export class NotificationService {
  async listForMember(p: PaginationParams, memberId: string, opts: ListOptions = {}) {
    const where: Record<string, unknown> = { memberId };
    if (opts.networkId) where.networkId = opts.networkId;
    if (opts.group && opts.group !== 'all') where.notifGroup = opts.group;
    if (opts.isUnreadOnly) where.readAt = null;
    if (opts.isReadOnly) where.readAt = { not: null };

    const [rows, total, totalAll, unread] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: p.skip,
        take: p.take,
      }),
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { memberId } }),
      prisma.notification.count({ where: { memberId, readAt: null } }),
    ]);

    const enriched = rows.map((r) => ({ ...r, timeBucket: timeBucket(r.createdAt) }));
    return { rows: enriched, total, totalAll, unread };
  }

  async markSeen(
    memberId: string,
    opts: { notificationId?: string; notificationIds?: string[]; markAllRead?: boolean },
  ) {
    if (!opts.markAllRead && !opts.notificationId && (!opts.notificationIds || opts.notificationIds.length === 0)) {
      return { count: 0 };
    }
    const where: Record<string, unknown> = { memberId };
    if (opts.notificationId) {
      where.id = opts.notificationId;
    } else if (opts.notificationIds && opts.notificationIds.length > 0) {
      where.id = { in: opts.notificationIds };
    }
    const now = new Date();
    const result = await prisma.notification.updateMany({
      where,
      data: { seenAt: now, readAt: now },
    });
    return result;
  }

  async mute(memberId: string, scope: string, refId: string) {
    if (scope !== 'post' && scope !== 'network') {
      throw new Error('scope must be post or network');
    }
    await prisma.notificationMute.upsert({
      where: { memberId_scope_refId: { memberId, scope, refId } },
      create: { memberId, scope, refId },
      update: {},
    });
    return { scope, refId, muted: true };
  }

  async unmute(memberId: string, scope: string, refId: string) {
    await prisma.notificationMute.deleteMany({
      where: { memberId, scope, refId },
    });
    return { scope, refId, muted: false };
  }
}
