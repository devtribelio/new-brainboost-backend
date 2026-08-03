import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { notificationEvents } from '@bb/common/events/notification-events';
import { NotificationProducer } from '../notification.producer';
import { RecipientResolver } from '../recipient.resolver';
import { resolveMentionMemberIds } from '../mentions.util';
import { MuteScope } from '../mute-scope';
import { ActionLabel, NotifGroup } from '../action-labels';

const producer = new NotificationProducer();
const resolver = new RecipientResolver();

export function registerCommentNotificationListener(): void {
  notificationEvents.on('comment.created', async (e) => {
    try {
      const [post, actor] = await Promise.all([
        prisma.post.findUnique({
          where: { id: e.postId },
          select: { authorId: true, topicId: true, networkId: true, excerpt: true },
        }),
        prisma.member.findUnique({ where: { id: e.authorId }, select: { fullName: true } }),
      ]);
      if (!post || !actor) return;

      const mentionedIds = await resolveMentionMemberIds(e.content);
      const mentionedSet = new Set(mentionedIds);

      const isReply = !!e.parentId;
      let parentAuthorId: string | null = null;
      if (isReply) {
        const parent = await prisma.comment.findUnique({
          where: { id: e.parentId! },
          select: { authorId: true },
        });
        parentAuthorId = parent?.authorId ?? null;
      }

      // Primary recipient: post author (for newComment) atau parent comment author (for newReply).
      const primaryRecipient = isReply ? parentAuthorId : post.authorId;

      const targets = new Map<string, ActionLabel>();
      if (primaryRecipient && primaryRecipient !== e.authorId) {
        targets.set(primaryRecipient, isReply ? ActionLabel.NewReply : ActionLabel.NewComment);
      }
      for (const mid of mentionedSet) {
        if (mid === e.authorId) continue;
        // Tag takes precedence over newComment/newReply when both apply.
        targets.set(mid, ActionLabel.Tag);
      }

      if (targets.size === 0) return;
      const enabled = await resolver.filterEnabled([...targets.keys()]);
      if (enabled.length === 0) return;
      const muteScopes: Array<{ scope: string; refId: string }> = [
        { scope: MuteScope.Post, refId: e.postId },
      ];
      if (post.topicId) muteScopes.push({ scope: MuteScope.Topic, refId: post.topicId });
      if (post.networkId) muteScopes.push({ scope: MuteScope.Network, refId: post.networkId });
      const notMuted = await resolver.filterNotMuted(enabled, muteScopes);
      if (notMuted.length === 0) return;

      const excerpt = e.content.slice(0, 200);

      for (const memberId of notMuted) {
        const label = targets.get(memberId)!;
        const title =
          label === ActionLabel.Tag
            ? `${actor.fullName} menandai kamu di ${isReply ? 'balasan' : 'komentar'}`
            : label === ActionLabel.NewReply
              ? `${actor.fullName} membalas komentarmu`
              : `${actor.fullName} mengomentari postinganmu`;

        await producer.createForMember({
          memberId,
          type: label,
          notifGroup: NotifGroup.General,
          networkId: post.networkId,
          title,
          body: excerpt,
          payload: {
            refTable: 'comment',
            refId: e.commentId,
            postId: e.postId,
            parentId: e.parentId,
            actorId: e.authorId,
          },
          dedupeKey: `${label}:${e.commentId}:${memberId}`,
        });
      }
    } catch (err) {
      logger.error({ err, commentId: e.commentId }, '[notification] comment.created listener failed');
    }
  });

  notificationEvents.on('comment.liked', async (e) => {
    try {
      if (e.actorId === e.commentAuthorId) return;
      const [actor, comment] = await Promise.all([
        prisma.member.findUnique({
          where: { id: e.actorId },
          select: { fullName: true },
        }),
        // The event carries no postId, but mute is scoped to the post/topic/network
        // the comment hangs off — so resolve them through the parent post.
        prisma.comment.findUnique({
          where: { id: e.commentId },
          select: { postId: true, post: { select: { topicId: true, networkId: true } } },
        }),
      ]);
      if (!actor || !comment) return;

      const muteScopes: Array<{ scope: MuteScope; refId: string }> = [
        { scope: MuteScope.Post, refId: comment.postId },
      ];
      if (comment.post.topicId) muteScopes.push({ scope: MuteScope.Topic, refId: comment.post.topicId });
      if (comment.post.networkId)
        muteScopes.push({ scope: MuteScope.Network, refId: comment.post.networkId });
      const notMuted = await resolver.filterNotMuted([e.commentAuthorId], muteScopes);
      if (notMuted.length === 0) return;

      await producer.createForMember({
        memberId: e.commentAuthorId,
        type: ActionLabel.NewLike,
        notifGroup: NotifGroup.General,
        title: `${actor.fullName} menyukai komentarmu`,
        payload: { refTable: 'comment', refId: e.commentId, actorId: e.actorId },
        dedupeKey: `newLike:comment:${e.commentId}:${e.actorId}`,
      });
    } catch (err) {
      logger.error({ err, commentId: e.commentId }, '[notification] comment.liked listener failed');
    }
  });
}
