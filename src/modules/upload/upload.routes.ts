import { Router } from 'express';
import multer from 'multer';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';
import { authGuard } from '@/common/middlewares/auth.middleware';
import { asyncHandler } from '@/common/utils/async-handler';
import { env } from '@/config/env';

const upload = multer({ dest: env.upload.tempDir });

export function uploadRoutes(): Router {
  const router = Router();
  const ctrl = new UploadController(new UploadService());

  router.post('/upload/temporary', authGuard, upload.array('image'), asyncHandler(ctrl.temporary));

  return router;
}
