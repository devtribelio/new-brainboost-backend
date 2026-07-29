import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { notificationEvents } from '@bb/common/events/notification-events';
import { NotificationProducer } from '../notification.producer';
import { RecipientResolver } from '../recipient.resolver';
import { ActionLabel, NotifGroup } from '../action-labels';

const producer = new NotificationProducer();
const resolver = new RecipientResolver();

/**
 * Fans a newly published post out to the topic's subscribers.
 *
 * This is the payoff of `POST /topic/subscribe`: subscribing is what puts a
 * member on this recipient list. Author is excluded; mutes are honoured per
 * topic AND per parent network so an existing network mute keeps working.
 */
export function registerTopicNotificationListener(): void {
  notificationEvents.on('post.published', async (e) => {
    try {
      if (!e.topicId) return;

      const [topic, author] = await Promise.all([
        prisma.topic.findUnique({
          where: { id: e.topicId },
          select: { id: true, name: true, networkId: true, isActive: true },
        }),
        prisma.member.findUnique({ where: { id: e.authorId }, select: { fullName: true } }),
      ]);
      if (!topic || !topic.isActive || !author) return;

      const enabled = await resolver.resolveForTopic(topic.id, e.authorId);
      if (enabled.length === 0) return;

      const muteScopes: Array<{ scope: string; refId: string }> = [{ scope: 'topic', refId: topic.id }];
      if (topic.networkId) muteScopes.push({ scope: 'network', refId: topic.networkId });
      const recipients = await resolver.filterNotMuted(enabled, muteScopes);
      if (recipients.length === 0) return;

      await producer.createForMany(
        recipients,
        {
          type: ActionLabel.NewPost,
          notifGroup: NotifGroup.General,
          networkId: topic.networkId,
          title: `${author.fullName} memposting di ${topic.name}`,
          body: e.excerpt,
          payload: {
            refTable: 'post',
            refId: e.postId,
            topicId: topic.id,
            networkId: topic.networkId,
            actorId: e.authorId,
          },
        },
        `newPost:${e.postId}`,
      );
    } catch (err) {
      logger.error({ err, postId: e.postId }, '[notification] post.published topic listener failed');
    }
  });
}
