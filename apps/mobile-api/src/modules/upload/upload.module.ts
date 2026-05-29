import type { AppModule } from '@bb/common/core/module.interface';
import { uploadRoutes } from './upload.routes';

export const UploadModule: AppModule = {
  name: 'upload',
  prefix: '/member',
  routes: uploadRoutes,
};
