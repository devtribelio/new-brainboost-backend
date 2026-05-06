import type { Request, Response } from 'express';
import { UploadService } from './upload.service';
import { notImplemented } from '@/common/utils/response.util';

export class UploadController {
  constructor(private readonly _uploadService: UploadService) {}

  temporary = async (_req: Request, res: Response) => notImplemented(res, 'upload.temporary');
}
