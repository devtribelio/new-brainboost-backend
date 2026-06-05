import type { Notification } from '@prisma/client';

export function serializeNotification(n: Notification): Record<string, unknown> {
  return {
    // FE NotificationModel — typed (int?, 0/1 ints, ISO strings).
    // refTable/refId now live inside `payload` (set by notification listeners).
    notificationId: n.id,
    title: n.title,
    message: n.body,
    isSeen: n.seenAt !== null ? 1 : 0,
    created: n.createdAt.toISOString(),
    updated: (n.readAt ?? n.createdAt).toISOString(),
    payload: (n.payload ?? null) as Record<string, unknown> | null,
    type: n.type,
  };
}
