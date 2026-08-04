import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { notificationEvents } from '@bb/common/events/notification-events';
import { NotificationProducer } from '../notification.producer';
import { RecipientResolver } from '../recipient.resolver';
import { MuteScope } from '../mute-scope';
import { ActionLabel, NotifGroup } from '../action-labels';

const producer = new NotificationProducer();
const resolver = new RecipientResolver();

// A topic's subscriber count is unbounded, unlike a network team. createForMany
// fans out with Promise.allSettled over every id it is handed, so passing the
// whole list would burst thousands of concurrent queries + FCM sends straight
// from the request path. Slice it and let each chunk drain first.
const FANOUT_CHUNK_SIZE = 200;

export function registerTopicNotificationListener(): void {
  notificationEvents.on('post.published', async (e) => {
    const topicId = e.topicId;
    if (!topicId) return;
    try {
      const [topic, author, subscriberIds] = await Promise.all([
        prisma.topic.findUnique({ where: { id: topicId }, select: { name: true } }),
        prisma.member.findUnique({ where: { id: e.authorId }, select: { fullName: true } }),
        resolver.subscriberIdsForTopic(topicId, e.authorId),
      ]);
      if (!topic || !author || subscriberIds.length === 0) return;

      // No 'post' scope here on purpose: the post was created moments ago, so
      // nobody can have muted it. Topic (and its parent network) are the only
      // opt-outs that can already exist.
      const muteScopes: Array<{ scope: MuteScope; refId: string }> = [
        { scope: MuteScope.Topic, refId: topicId },
      ];
      if (e.networkId) muteScopes.push({ scope: MuteScope.Network, refId: e.networkId });

      let created = 0;
      let pushMuted = 0;
      for (let i = 0; i < subscriberIds.length; i += FANOUT_CHUNK_SIZE) {
        const chunk = subscriberIds.slice(i, i + FANOUT_CHUNK_SIZE);
        // A muted subscriber still gets a row (createForMany only withholds
        // their push), so they stay in the batch — unlike an opted-out one.
        const enabled = await resolver.filterEnabled(chunk);
        if (enabled.length === 0) continue;

        const result = await producer.createForMany(
          enabled,
          {
            type: ActionLabel.NewPost,
            notifGroup: NotifGroup.General,
            networkId: e.networkId,
            title: `${author.fullName} memposting di ${topic.name}`,
            body: e.excerpt,
            payload: {
              refTable: 'post',
              refId: e.postId,
              topicId,
              actorId: e.authorId,
            },
            muteScopes,
          },
          `newPost:${e.postId}`,
        );
        created += result.created;
        pushMuted += result.pushMuted;
      }

      logger.info(
        { postId: e.postId, topicId, subscribers: subscriberIds.length, created, pushMuted },
        '[notification] topic fan-out done',
      );
    } catch (err) {
      logger.error({ err, postId: e.postId, topicId }, '[notification] post.published topic listener failed');
    }
  });
}
