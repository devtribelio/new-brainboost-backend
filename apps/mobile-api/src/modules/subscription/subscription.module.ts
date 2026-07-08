import type { AppModule } from '@bb/common/core/module.interface';
import { subscriptionRoutes } from './subscription.routes';

export const SubscriptionModule: AppModule = {
  name: 'subscription',
  prefix: '/subscription',
  routes: subscriptionRoutes,
};
