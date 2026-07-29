import { registerCommerceNotificationListener } from './commerce.listener';
import { registerPostNotificationListener } from './post.listener';
import { registerCommentNotificationListener } from './comment.listener';
import { registerNetworkNotificationListener } from './network.listener';

/**
 * Topic fan-out is deliberately absent here: new posts in a subscribed topic are
 * NOT pushed as they happen, they are recapped once a day at 21:00 WIB by the
 * `topicDigestNotifications` job. `post.published` therefore has no listener —
 * the job reads the `posts` table directly over a fixed window.
 */
export function registerNotificationListeners(): void {
  registerCommerceNotificationListener();
  registerPostNotificationListener();
  registerCommentNotificationListener();
  registerNetworkNotificationListener();
}
