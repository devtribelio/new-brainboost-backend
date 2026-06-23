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
//
// SECURITY (DoS): memoryStorage buffers every part fully in RAM. Without a file
// COUNT cap, one authenticated member could POST thousands of `image` parts in a
// single request, pinning gigabytes of heap (worker OOM) and flooding S3.
// fileSize bounds each part; MAX_UPLOAD_FILES/parts bound the count.
const MAX_UPLOAD_FILES = 10;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.upload.maxBytes,
    files: MAX_UPLOAD_FILES,
    parts: MAX_UPLOAD_FILES + 5,
  },
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
    middlewares: [authGuard, validateDto(UploadQueryDto, 'query'), upload.array('image', MAX_UPLOAD_FILES)],
  });

  return router;
}
