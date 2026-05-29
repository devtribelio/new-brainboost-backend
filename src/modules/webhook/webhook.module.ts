import type { AppModule } from '@bb/common/core/module.interface';
import { webhookRoutes } from './webhook.routes';

export const WebhookModule: AppModule = {
  name: 'webhook',
  prefix: '/webhook',
  routes: webhookRoutes,
};
