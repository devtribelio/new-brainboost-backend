import type { Notification } from '@prisma/client';

// FE NotificationModel — derive refTable/refId from payload when recognizable.
// Common payload shapes from notification.service produce {postId, commentId, ...}.
function deriveRef(payload: unknown): { refTable: string | null; refId: number | null } {
  if (!payload || typeof payload !== 'object') return { refTable: null, refId: null };
  const p = payload as Record<string, unknown>;
  // Pick first recognized id field. Order matters — most-specific first.
  if (typeof p.commentId === 'number') return { refTable: 'comments', refId: p.commentId };
  if (typeof p.postId === 'number') return { refTable: 'posts', refId: p.postId };
  if (typeof p.replyId === 'number') return { refTable: 'replies', refId: p.replyId };
  if (typeof p.memberId === 'number') return { refTable: 'members', refId: p.memberId };
  return { refTable: null, refId: null };
}

export function serializeNotification(n: Notification): Record<string, unknown> {
  const { refTable, refId } = deriveRef(n.payload);
  return {
    // FE NotificationModel — typed (int?, 0/1 ints, ISO strings, refTable+refId
    // for deep-link navigation).
    notificationId: n.id,
    title: n.title,
    message: n.body,
    isSeen: n.seenAt !== null ? 1 : 0,
    created: n.createdAt.toISOString(),
    updated: (n.readAt ?? n.createdAt).toISOString(),
    refTable,
    refId,
    type: n.type,
  };
}
