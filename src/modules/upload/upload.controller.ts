import type { Request, Response } from 'express';
import { UploadService } from './upload.service';
import { notImplemented } from '@/common/utils/response.util';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@/common/openapi/decorators';

@ApiTags('Upload')
@ApiBearerAuth()
export class UploadController {
  constructor(private readonly _uploadService: UploadService) {}

  @ApiOperation({
    summary: 'Upload one or more files to a temporary bucket',
    description: 'Multipart form, field name `image[]`. Returns transient ids consumed by other endpoints.',
  })
  @ApiResponse({ status: 200 })
  temporary = async (_req: Request, res: Response) => notImplemented(res, 'upload.temporary');
}
