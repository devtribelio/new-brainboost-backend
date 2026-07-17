import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { notificationEvents } from '@bb/common/events/notification-events';
import { NotificationProducer } from '../notification.producer';
import { ActionLabel, NotifGroup } from '../action-labels';

const producer = new NotificationProducer();

export function registerPostNotificationListener(): void {
  notificationEvents.on('post.liked', async (e) => {
    try {
      if (e.actorId === e.postAuthorId) return;
      const actor = await prisma.member.findUnique({
        where: { id: e.actorId },
        select: { fullName: true },
      });
      if (!actor) return;

      await producer.createForMember({
        memberId: e.postAuthorId,
        type: ActionLabel.NewLike,
        notifGroup: NotifGroup.General,
        title: `${actor.fullName} menyukai postinganmu`,
        payload: { refTable: 'post', refId: e.postId, actorId: e.actorId },
        dedupeKey: `newLike:post:${e.postId}:${e.actorId}`,
      });
    } catch (err) {
      logger.error({ err, postId: e.postId }, '[notification] post.liked listener failed');
    }
  });
}
