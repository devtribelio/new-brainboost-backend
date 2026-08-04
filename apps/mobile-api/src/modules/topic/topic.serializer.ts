import type { Topic } from '@prisma/client';

export function serializeTopic(
  t: Topic & {
    isSubscribed?: boolean;
    isMute?: boolean;
    countPost?: number;
    orderNumber?: number;
  },
): Record<string, unknown> {
  return {
    // Legacy field names (mobile TopicModel)
    topicId: t.legacyId ?? t.id,
    name: t.name,
    icon: t.iconUrl,
    iconType: t.iconType ?? (t.iconUrl ? 'image' : null),
    type: t.type,
    countPost: t.countPost ?? 0,
    orderNumber: t.orderNumber ?? 0,
    isSubscribeTopic: t.isSubscribed ?? false,
    // Always false for anonymous callers — mute is per member.
    isMute: t.isMute ?? false,
    // Backend-native (extras)
    id: t.id,
    networkId: t.networkId,
    description: t.description,
    iconUrl: t.iconUrl,
    isActive: t.isActive,
    createdAt: t.createdAt,
  };
}
