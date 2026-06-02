import { Router } from 'express';
import multer from 'multer';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';
import { UploadQueryDto } from './dto/upload.dto';
import { authGuard } from '@bb/common/middlewares/auth.middleware';
import { validateDto } from '@bb/common/middlewares/validation.middleware';
import { bindRoute } from '@bb/common/openapi/route-binder';
import { env } from '@bb/common/config/env';

// In-memory storage: we need the raw buffer to run sharp + push to S3.
// Nothing touches local disk anymore.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.upload.maxBytes },
});

export function uploadRoutes(): Router {
  const router = Router();
  const ctrl = new UploadController(new UploadService());

  bindRoute({
    router,
    controller: ctrl,
    method: 'post',
    path: '/upload/temporary',
    handlerKey: 'temporary',
    middlewares: [authGuard, validateDto(UploadQueryDto, 'query'), upload.array('image')],
  });

  return router;
}
