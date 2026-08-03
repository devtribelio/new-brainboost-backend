import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { notificationEvents } from '@bb/common/events/notification-events';
import { NotificationProducer } from '../notification.producer';
import { RecipientResolver } from '../recipient.resolver';
import { MuteScope } from '../mute-scope';
import { ActionLabel, NotifGroup } from '../action-labels';

const producer = new NotificationProducer();
const resolver = new RecipientResolver();

export function registerPostNotificationListener(): void {
  notificationEvents.on('post.liked', async (e) => {
    try {
      if (e.actorId === e.postAuthorId) return;
      const [actor, post] = await Promise.all([
        prisma.member.findUnique({
          where: { id: e.actorId },
          select: { fullName: true },
        }),
        prisma.post.findUnique({
          where: { id: e.postId },
          select: { topicId: true, networkId: true },
        }),
      ]);
      if (!actor || !post) return;

      const muteScopes: Array<{ scope: MuteScope; refId: string }> = [
        { scope: MuteScope.Post, refId: e.postId },
      ];
      if (post.topicId) muteScopes.push({ scope: MuteScope.Topic, refId: post.topicId });
      if (post.networkId) muteScopes.push({ scope: MuteScope.Network, refId: post.networkId });
      const notMuted = await resolver.filterNotMuted([e.postAuthorId], muteScopes);
      if (notMuted.length === 0) return;

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
