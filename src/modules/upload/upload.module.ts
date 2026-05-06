import type { AppModule } from '@/core/module.interface';
import { uploadRoutes } from './upload.routes';

export const UploadModule: AppModule = {
  name: 'upload',
  prefix: '/member',
  routes: uploadRoutes,
};
