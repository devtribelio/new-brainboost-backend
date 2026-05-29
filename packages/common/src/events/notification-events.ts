import { EventEmitter } from 'node:events';

export interface PostPublishedEvent {
  postId: string;
  authorId: string;
  networkId: string | null;
  excerpt: string;
}

export interface CommentCreatedEvent {
  commentId: string;
  postId: string;
  authorId: string;
  parentId: string | null;
  content: string;
}

export interface PostLikedEvent {
  postId: string;
  postAuthorId: string;
  actorId: string;
}

export interface CommentLikedEvent {
  commentId: string;
  commentAuthorId: string;
  actorId: string;
}

export interface NetworkMemberRequestedEvent {
  requestId: string;
  networkId: string;
  memberId: string;
}

export interface NetworkMemberApprovedEvent {
  requestId: string;
  networkId: string;
  memberId: string;
  approverId: string;
}

export interface NetworkMemberJoinedEvent {
  networkId: string;
  memberId: string;
}

export type NotificationEventMap = {
  'post.published': PostPublishedEvent;
  'comment.created': CommentCreatedEvent;
  'post.liked': PostLikedEvent;
  'comment.liked': CommentLikedEvent;
  'network.member.requested': NetworkMemberRequestedEvent;
  'network.member.approved': NetworkMemberApprovedEvent;
  'network.member.joined': NetworkMemberJoinedEvent;
};

class TypedEmitter {
  private bus = new EventEmitter();

  emit<K extends keyof NotificationEventMap>(event: K, payload: NotificationEventMap[K]): void {
    this.bus.emit(event, payload);
  }

  on<K extends keyof NotificationEventMap>(
    event: K,
    listener: (payload: NotificationEventMap[K]) => void | Promise<void>,
  ): void {
    this.bus.on(event, (payload: NotificationEventMap[K]) => {
      Promise.resolve(listener(payload)).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[notification-events] listener for ${event} threw`, err);
      });
    });
  }
}

export const notificationEvents = new TypedEmitter();
