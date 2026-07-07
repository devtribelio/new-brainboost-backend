import { registerCommerceNotificationListener } from './commerce.listener';
import { registerPostNotificationListener } from './post.listener';
import { registerCommentNotificationListener } from './comment.listener';
import { registerNetworkNotificationListener } from './network.listener';
import { registerSubscriptionNotificationListener } from './subscription.listener';

export function registerNotificationListeners(): void {
  registerCommerceNotificationListener();
  registerPostNotificationListener();
  registerCommentNotificationListener();
  registerNetworkNotificationListener();
  registerSubscriptionNotificationListener();
}
