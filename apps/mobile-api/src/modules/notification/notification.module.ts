import type { AppModule } from '@bb/common/core/module.interface';
import { notificationRoutes } from './notification.routes';

export const NotificationModule: AppModule = {
  name: 'notification',
  prefix: '/member',
  routes: notificationRoutes,
};
