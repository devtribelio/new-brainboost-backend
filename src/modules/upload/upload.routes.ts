import { Router } from 'express';
import multer from 'multer';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';
import { authGuard } from '@/common/middlewares/auth.middleware';
import { bindRoute } from '@/common/openapi/route-binder';
import { env } from '@/config/env';

const upload = multer({ dest: env.upload.tempDir });

export function uploadRoutes(): Router {
  const router = Router();
  const ctrl = new UploadController(new UploadService());

  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/upload/temporary',
    handlerKey: 'temporary',
    middlewares: [authGuard, upload.array('image')],
  });

  return router;
}
