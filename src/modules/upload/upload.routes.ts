import path from 'node:path';
import fs from 'node:fs';
import { Router } from 'express';
import multer from 'multer';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';
import { authGuard } from '@/common/middlewares/auth.middleware';
import { bindRoute } from '@/common/openapi/route-binder';
import { env } from '@/config/env';

fs.mkdirSync(env.upload.tempDir, { recursive: true });

const storage = multer.diskStorage({
  destination: env.upload.tempDir,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`;
    cb(null, unique);
  },
});

const upload = multer({
  storage,
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
    middlewares: [authGuard, upload.array('image')],
  });

  return router;
}
