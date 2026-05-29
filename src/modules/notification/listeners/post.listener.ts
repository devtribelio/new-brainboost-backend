import { prisma } from '@bb/db';
import { logger } from '@/config/logger';
import { notificationEvents } from '@/common/events/notification-events';
import { NotificationProducer } from '../notification.producer';
import { RecipientResolver } from '../recipient.resolver';
import { ActionLabel, NotifGroup } from '../action-labels';

const producer = new NotificationProducer();
const resolver = new RecipientResolver();

const POST_FANOUT_LIMIT = 500;

export function registerPostNotificationListener(): void {
  notificationEvents.on('post.published', async (e) => {
    try {
      if (!e.networkId) return;
      const [network, author] = await Promise.all([
        prisma.network.findUnique({ where: { id: e.networkId }, select: { name: true } }),
        prisma.member.findUnique({ where: { id: e.authorId }, select: { fullName: true } }),
      ]);
      if (!network || !author) return;

      const recipients = await resolver.resolveForNetwork(e.networkId, e.authorId);
      if (recipients.length === 0) return;
      const notMuted = await resolver.filterNotMuted(recipients, [
        { scope: 'network', refId: e.networkId },
      ]);
      if (notMuted.length === 0) return;
      const fanout = notMuted.slice(0, POST_FANOUT_LIMIT);
      const title = `${author.fullName} posted in ${network.name}`;

      await producer.createForMany(
        fanout,
        {
          type: ActionLabel.NewPost,
          notifGroup: NotifGroup.General,
          networkId: e.networkId,
          title,
          body: e.excerpt,
          payload: { refTable: 'post', refId: e.postId, networkId: e.networkId, actorId: e.authorId },
        },
        `newPost:${e.postId}`,
      );
    } catch (err) {
      logger.error({ err, postId: e.postId }, '[notification] post.published listener failed');
    }
  });

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
        title: `${actor.fullName} liked your post`,
        payload: { refTable: 'post', refId: e.postId, actorId: e.actorId },
        dedupeKey: `newLike:post:${e.postId}:${e.actorId}`,
      });
    } catch (err) {
      logger.error({ err, postId: e.postId }, '[notification] post.liked listener failed');
    }
  });
}
